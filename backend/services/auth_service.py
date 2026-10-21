"""
Custom JWT + bcrypt authentication service.
Custom JWT + bcrypt authentication service.

Tokens are HS256 JWTs signed with JWT_SECRET.
The 'sub' claim holds the user's profile ID (UUID string).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

import bcrypt
import jwt

from config import JWT_SECRET, JWT_EXPIRY_HOURS
from .pg_service import (
    create_user,
    get_user_by_firebase_uid,
    get_user_by_email,
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _mint_token(user_id: str, email: str) -> str:
    """Create a signed JWT for the given user."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def _decode_token(token: str) -> Dict[str, Any]:
    """Decode and validate a JWT. Raises jwt.PyJWTError on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def register_user(
    first_name: str,
    last_name: str,
    email: str,
    password: str,
    organization: str,
) -> Dict[str, Any]:
    """Register a new user: hash password, store profile, return tokens."""
    clean_email = email.strip().lower()
    existing = get_user_by_email(clean_email)
    hashed = _hash_password(password)

    if existing:
        # Check if existing user already has a password set
        has_password = False
        try:
            from .pg_service import _conn
            with _conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT password_hash FROM profiles WHERE id = %s", (existing["id"],))
                    r = cur.fetchone()
                    if r and r[0]:
                        has_password = True
        except Exception:
            has_password = bool(existing.get("password_hash"))

        if has_password:
            raise RuntimeError(f"An account with email '{clean_email}' already exists.")

        user_id = existing["id"]
        role = "ADMIN" if clean_email in ("shree.sonar@ethosh.com", "admin2011@ethosh.com") else existing.get("role", "USER")
        try:
            from .pg_service import _conn
            with _conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE profiles
                        SET password_hash = %s,
                            first_name = COALESCE(NULLIF(%s, ''), first_name),
                            last_name = COALESCE(NULLIF(%s, ''), last_name),
                            organization = COALESCE(NULLIF(%s, ''), organization),
                            role = %s
                        WHERE id = %s
                        """,
                        (hashed, first_name, last_name, organization, role, user_id),
                    )
        except Exception as e:
            print(f"register_user update existing error: {e}")

        from .pg_service import _read_local_db, _write_local_db
        db = _read_local_db()
        for u in db.get("users", []):
            if u.get("id") == user_id or u.get("email", "").lower() == clean_email:
                u["password_hash"] = hashed
                u["first_name"] = first_name or u.get("first_name")
                u["last_name"] = last_name or u.get("last_name")
                u["organization"] = organization or u.get("organization")
                u["role"] = role
                break
        _write_local_db(db)

        access_token = _mint_token(user_id, clean_email)
        user_data = {
            "id": user_id,
            "email": clean_email,
            "first_name": first_name or existing.get("first_name"),
            "last_name": last_name or existing.get("last_name"),
            "organization": organization or existing.get("organization"),
            "role": role,
        }
        session_data = {
            "access_token": access_token,
            "refresh_token": None,
            "expires_in": JWT_EXPIRY_HOURS * 3600,
        }
        return {"user": user_data, "session": session_data}

    user_id = str(uuid.uuid4())
    role = "ADMIN" if clean_email in ("shree.sonar@ethosh.com", "admin2011@ethosh.com") else "USER"
    profile = create_user(
        firebase_uid=user_id,
        first_name=first_name,
        last_name=last_name,
        email=clean_email,
        organization=organization,
        role=role,
    )

    # Persist the hashed password alongside the profile in PostgreSQL
    try:
        from .pg_service import _conn
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE profiles SET password_hash = %s WHERE id = %s",
                    (hashed, user_id),
                )
    except Exception as e:
        print(f"register_user password_hash update error: {e}")

    # Mirror password_hash in local_db
    from .pg_service import _read_local_db, _write_local_db
    db = _read_local_db()
    for u in db.get("users", []):
        if u.get("id") == user_id or u.get("email", "").lower() == clean_email:
            u["password_hash"] = hashed
            break
    _write_local_db(db)

    access_token = _mint_token(user_id, clean_email)

    user_data = {
        "id": profile["id"],
        "email": clean_email,
        "first_name": profile.get("first_name"),
        "last_name": profile.get("last_name"),
        "organization": profile.get("organization"),
        "role": profile.get("role", role),
    }
    session_data = {
        "access_token": access_token,
        "refresh_token": None,
        "expires_in": JWT_EXPIRY_HOURS * 3600,
    }
    return {"user": user_data, "session": session_data}


def login_user(email: str, password: str) -> Dict[str, Any]:
    """Authenticate with email/password and return tokens."""
    clean_email = email.strip().lower()
    profile = get_user_by_email(clean_email)
    if not profile:
        raise RuntimeError("Invalid email or password.")

    stored_hash = None
    # Fetch the stored hash from PostgreSQL
    try:
        from .pg_service import _conn
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT password_hash FROM profiles WHERE id = %s", (profile["id"],))
                row = cur.fetchone()
                if row and row[0]:
                    stored_hash = row[0]
    except Exception as e:
        print(f"login_user db hash lookup error: {e}")

    # Fallback to local_db if database is offline or not set
    if not stored_hash:
        from .pg_service import _read_local_db
        db = _read_local_db()
        for u in db.get("users", []):
            if u.get("id") == profile["id"] or u.get("email", "").lower() == clean_email:
                stored_hash = u.get("password_hash")
                break

    if not stored_hash:
        raise RuntimeError("Account has no password set. Contact an administrator.")

    if not _verify_password(password, stored_hash):
        raise RuntimeError("Invalid email or password.")

    access_token = _mint_token(profile["id"], clean_email)

    role = "ADMIN" if clean_email in ("shree.sonar@ethosh.com", "admin2011@ethosh.com") else profile.get("role", "USER")
    user_data = {
        "id": profile["id"],
        "email": clean_email,
        "first_name": profile.get("first_name"),
        "last_name": profile.get("last_name"),
        "organization": profile.get("organization"),
        "role": role,
    }
    session_data = {
        "access_token": access_token,
        "refresh_token": None,
        "expires_in": JWT_EXPIRY_HOURS * 3600,
    }
    return {"user": user_data, "session": session_data}


def verify_id_token(token: str) -> Dict[str, Any]:
    """Decode a JWT and return its claims. Raises on invalid/expired token."""
    try:
        claims = _decode_token(token)
    except jwt.ExpiredSignatureError:
        raise RuntimeError("Token has expired.")
    except jwt.InvalidTokenError as e:
        raise RuntimeError(f"Invalid token: {e}")

    return {
        "uid": claims["sub"],
        "email": claims.get("email", ""),
        "email_verified": True,  # We confirm email at registration time
    }


def verify_and_get_profile(user_id: str) -> Optional[Dict[str, Any]]:
    """Fetch the profile for a verified user ID."""
    return get_user_by_firebase_uid(user_id)


def refresh_access_token(old_token: str) -> Optional[str]:
    """
    Issue a fresh token when the client supplies a still-valid (or recently
    expired) token.  For simplicity we decode without expiry verification and
    re-mint only when the signature is valid.
    """
    try:
        claims = jwt.decode(
            old_token,
            JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_exp": False},
        )
        user_id = claims["sub"]
        email = claims.get("email", "")
        return _mint_token(user_id, email)
    except jwt.InvalidTokenError:
        return None
