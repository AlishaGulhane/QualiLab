"""
PostgreSQL database service.
Uses psycopg2 with a simple connection pool via psycopg2.pool.ThreadedConnectionPool.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool

from config import DATABASE_URL

# ---------------------------------------------------------------------------
# Connection pool (initialised lazily on first use)
# ---------------------------------------------------------------------------

_pool: Optional[pgpool.ThreadedConnectionPool] = None


import time
_last_db_failure_time = 0
_DB_FAILURE_COOLDOWN = 60  # seconds

def _get_pool() -> pgpool.ThreadedConnectionPool:
    global _pool, _last_db_failure_time
    if _pool is not None:
        return _pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL must be set in environment")
    if time.time() - _last_db_failure_time < _DB_FAILURE_COOLDOWN:
        raise RuntimeError("Database offline (cooldown active)")
    try:
        _pool = pgpool.ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=DATABASE_URL,
            connect_timeout=2
        )
        return _pool
    except Exception as e:
        _last_db_failure_time = time.time()
        raise e


@contextmanager
def _conn():
    """Context manager: yields a psycopg2 connection from the pool and commits/returns it."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        conn.autocommit = False
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def _row_to_dict(cursor, row) -> Dict[str, Any]:
    """Convert a psycopg2 row to a plain dict using column names."""
    if row is None:
        return None
    cols = [desc[0] for desc in cursor.description]
    return dict(zip(cols, row))


def _rows_to_dicts(cursor) -> List[Dict[str, Any]]:
    return [_row_to_dict(cursor, row) for row in cursor.fetchall()]


def _serialize_dates(d: Dict[str, Any]) -> Dict[str, Any]:
    """Convert datetime objects to ISO strings so callers get consistent output."""
    result = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            result[k] = v.isoformat()
        elif isinstance(v, dict):
            result[k] = _serialize_dates(v)
        else:
            result[k] = v
    return result


# ---------------------------------------------------------------------------
# Local JSON Fallback Helpers (for local dev when DB is offline)
# ---------------------------------------------------------------------------

LOCAL_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "local_db.json")

def _read_local_db() -> dict:
    if os.path.exists(LOCAL_DB_PATH):
        try:
            with open(LOCAL_DB_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"users": [], "pdf_uploads": [], "feedback": [], "user_dictionary": [], "user_activity": []}

def _write_local_db(data: dict):
    try:
        with open(LOCAL_DB_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[local_db] Write error: {e}")


# ---------------------------------------------------------------------------
# Profile (users) operations
# ---------------------------------------------------------------------------

def create_user(
    firebase_uid: str,
    first_name: str,
    last_name: str,
    email: str,
    organization: str,
    role: str = "USER",
) -> Dict[str, Any]:
    """Create user profile in the profiles table."""
    now = datetime.now(timezone.utc)
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                try:
                    cur.execute(
                        """
                        INSERT INTO profiles (id, email, first_name, last_name, organization, role, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (id) DO NOTHING
                        RETURNING *
                        """,
                        (firebase_uid, email, first_name, last_name, organization, role, now, now),
                    )
                    row = cur.fetchone()
                    if row:
                        return _serialize_dates(_row_to_dict(cur, row))
                except Exception as e:
                    print(f"create_user insert error: {e}")
                    conn.rollback()

        # Row already existed in DB — return it
        existing = get_user_by_firebase_uid(firebase_uid)
        if existing:
            return existing
    except Exception as e:
        print(f"create_user db error: {e}")

    # Fallback to local_db
    user_data = {
        "id": firebase_uid,
        "email": email,
        "first_name": first_name,
        "last_name": last_name,
        "organization": organization,
        "role": role,
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }
    db = _read_local_db()
    users = db.setdefault("users", [])
    existing_idx = next((i for i, u in enumerate(users) if u.get("id") == firebase_uid or u.get("email", "").lower() == email.lower()), None)
    if existing_idx is not None:
        users[existing_idx].update(user_data)
        _write_local_db(db)
        return users[existing_idx]
    users.append(user_data)
    _write_local_db(db)
    return user_data


def get_user_by_firebase_uid(firebase_uid: str) -> Optional[Dict[str, Any]]:
    """Get user profile by UID (stored in profiles.id)."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM profiles WHERE id = %s", (firebase_uid,))
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        print(f"get_user_by_firebase_uid error: {e}")
    # Local fallback
    db = _read_local_db()
    for u in db.get("users", []):
        if u.get("id") == firebase_uid:
            return u
    return None


def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    """Get user profile by email."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM profiles WHERE email = %s", (email,))
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        print(f"get_user_by_email error: {e}")
    # Local fallback
    db = _read_local_db()
    for u in db.get("users", []):
        if u.get("email", "").lower() == email.lower():
            return u
    return None


def delete_user(user_id: str) -> bool:
    """Delete a user and all associated data (cascades via FK constraints)."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM profiles WHERE id = %s", (user_id,))
        return True
    except Exception as e:
        print(f"delete_user error for {user_id}: {e}")
        db = _read_local_db()
        users = [u for u in db.get("users", []) if u.get("id") != user_id]
        db["users"] = users
        _write_local_db(db)
        return True


def update_user_role(user_id: str, new_role: str) -> bool:
    """Update a user's role. new_role must be 'USER' or 'ADMIN'."""
    try:
        now = datetime.now(timezone.utc)
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE profiles SET role = %s, updated_at = %s WHERE id = %s",
                    (new_role, now, user_id),
                )
        return True
    except Exception as e:
        print(f"update_user_role error for {user_id}: {e}")
        db = _read_local_db()
        for u in db.get("users", []):
            if u.get("id") == user_id:
                u["role"] = new_role
                u["updated_at"] = datetime.now(timezone.utc).isoformat()
                _write_local_db(db)
                return True
        return False


def get_all_users() -> List[Dict[str, Any]]:
    """Get all user profiles ordered newest first."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM profiles ORDER BY created_at DESC")
                return [_serialize_dates(r) for r in _rows_to_dicts(cur)]
    except Exception as e:
        print(f"get_all_users db error: {e}")
        db = _read_local_db()
        return db.get("users", [])


# ---------------------------------------------------------------------------
# PDF uploads
# ---------------------------------------------------------------------------

def create_pdf_upload(
    user_id: str,
    filename: str,
    s3_url: str,
    file_type: str,
    brand_guideline: str,
    document_content: str,
    status: str = "uploaded",
    file_size: Optional[int] = None,
) -> Dict[str, Any]:
    """Record a PDF upload."""
    now = datetime.now(timezone.utc)
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO pdf_uploads
                        (user_id, filename, s3_url, file_type, brand_guideline, document_content,
                         file_size, status, uploaded_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        user_id, filename, s3_url or None, file_type or None,
                        brand_guideline, document_content or None,
                        file_size, status, now, now,
                    ),
                )
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        print(f"create_pdf_upload db error: {e}")
        import uuid
        upload_record = {
            "id": f"up_{uuid.uuid4().hex[:12]}",
            "user_id": user_id,
            "filename": filename,
            "s3_url": s3_url or "",
            "file_type": file_type or "",
            "brand_guideline": brand_guideline,
            "document_content": document_content or "",
            "file_size": file_size or 0,
            "status": status,
            "uploaded_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "completed_at": None,
            "validation_summary": None,
        }
        db = _read_local_db()
        db.setdefault("pdf_uploads", []).append(upload_record)
        _write_local_db(db)
        return upload_record
    raise RuntimeError("Failed to create PDF upload record")


def get_user_uploads(user_id: str) -> List[Dict[str, Any]]:
    """Get uploads for a specific user, including their most recent feedback."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, filename, brand_guideline, status, uploaded_at,
                           validation_summary
                    FROM pdf_uploads
                    WHERE user_id = %s
                    ORDER BY uploaded_at DESC
                    """,
                    (user_id,),
                )
                uploads = [_serialize_dates(r) for r in _rows_to_dicts(cur)]

            if not uploads:
                return []

            # Fetch feedback for these uploads
            upload_ids = [u["id"] for u in uploads]
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ON (upload_id) upload_id, rating, comment, created_at
                    FROM feedback
                    WHERE upload_id = ANY(%s)
                    ORDER BY upload_id, created_at DESC
                    """,
                    (upload_ids,),
                )
                feedback_map: Dict[str, Dict] = {}
                for row in _rows_to_dicts(cur):
                    feedback_map[str(row["upload_id"])] = {
                        "rating": row.get("rating"),
                        "comment": row.get("comment", ""),
                    }

        result = []
        for u in uploads:
            u["feedback"] = feedback_map.get(str(u["id"]))
            u.setdefault("validation_summary", None)
            result.append(u)
        return result
    except Exception as e:
        print(f"get_user_uploads db error: {e}")
        db = _read_local_db()
        return [u for u in db.get("pdf_uploads", []) if u.get("user_id") == user_id]


def update_upload_status(
    upload_id: str,
    status: str,
    validation_summary: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Update the status (and optional validation_summary) of an upload record."""
    now = datetime.now(timezone.utc)
    completed_at = now if status in ("completed", "error", "failed") else None
    summary_json = json.dumps(validation_summary) if validation_summary is not None else None

    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE pdf_uploads
                    SET status = %s,
                        updated_at = %s,
                        completed_at = COALESCE(%s, completed_at),
                        validation_summary = COALESCE(%s::jsonb, validation_summary)
                    WHERE id = %s
                    RETURNING *
                    """,
                    (status, now, completed_at, summary_json, upload_id),
                )
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        print(f"update_upload_status db error: {e}")
        db = _read_local_db()
        for u in db.get("pdf_uploads", []):
            if u.get("id") == upload_id:
                u["status"] = status
                u["updated_at"] = now.isoformat()
                if completed_at:
                    u["completed_at"] = completed_at.isoformat()
                if validation_summary is not None:
                    u["validation_summary"] = validation_summary
                _write_local_db(db)
                return u
    return None


def get_all_uploads() -> List[Dict[str, Any]]:
    """Get all PDF uploads with associated user info."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT u.id, u.user_id, u.filename, u.brand_guideline, u.status,
                           u.uploaded_at, u.validation_summary,
                           p.first_name, p.last_name, p.email, p.organization
                    FROM pdf_uploads u
                    LEFT JOIN profiles p ON p.id = u.user_id
                    ORDER BY u.uploaded_at DESC
                    """
                )
                rows = _rows_to_dicts(cur)

        result = []
        for row in rows:
            entry = {
                "id": row["id"],
                "user_id": row["user_id"],
                "filename": row["filename"],
                "brand_guideline": row["brand_guideline"],
                "status": row["status"],
                "uploaded_at": row["uploaded_at"].isoformat() if isinstance(row["uploaded_at"], datetime) else row["uploaded_at"],
                "validation_summary": row.get("validation_summary"),
                "users": {
                    "first_name": row.get("first_name", ""),
                    "last_name": row.get("last_name", ""),
                    "email": row.get("email", ""),
                    "organization": row.get("organization", ""),
                },
            }
            result.append(entry)
        return result
    except Exception as e:
        print(f"get_all_uploads db error: {e}")
        db = _read_local_db()
        return db.get("pdf_uploads", [])


def create_feedback(user_id: str, upload_id: str, rating: int, comment: str = "") -> Dict[str, Any]:
    """Submit feedback for an upload."""
    now = datetime.now(timezone.utc)
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO feedback (user_id, upload_id, rating, comment, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (user_id, upload_id, rating, comment, now),
                )
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        print(f"create_feedback db error: {e}")
        import uuid
        fb = {
            "id": f"fb_{uuid.uuid4().hex[:8]}",
            "user_id": user_id,
            "upload_id": upload_id,
            "rating": rating,
            "comment": comment,
            "created_at": now.isoformat()
        }
        db = _read_local_db()
        db.setdefault("feedback", []).append(fb)
        _write_local_db(db)
        return fb
    raise RuntimeError("Failed to create feedback")


def get_all_feedback() -> List[Dict[str, Any]]:
    """Get all feedback entries with user info."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT f.id, f.user_id, f.upload_id, f.rating, f.comment, f.created_at,
                           p.first_name, p.last_name, p.email
                    FROM feedback f
                    LEFT JOIN profiles p ON p.id = f.user_id
                    ORDER BY f.created_at DESC
                    """
                )
                rows = _rows_to_dicts(cur)

        result = []
        for row in rows:
            entry = {
                "id": row["id"],
                "user_id": row["user_id"],
                "upload_id": row["upload_id"],
                "rating": row["rating"],
                "comment": row["comment"],
                "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else row["created_at"],
                "profiles": {
                    "first_name": row.get("first_name", ""),
                    "last_name": row.get("last_name", ""),
                    "email": row.get("email", ""),
                },
            }
            result.append(entry)
        return result
    except Exception as e:
        print(f"get_all_feedback db error: {e}")
        db = _read_local_db()
        return db.get("feedback", [])


def get_admin_stats() -> Dict[str, Any]:
    """Get admin dashboard statistics."""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM profiles")
                total_users = cur.fetchone()[0]

                cur.execute("SELECT COUNT(*) FROM pdf_uploads")
                total_uploads = cur.fetchone()[0]

                cur.execute(
                    "SELECT COUNT(*) FROM pdf_uploads WHERE status IN ('completed','failed','error','processing')"
                )
                total_jobs = cur.fetchone()[0]

                cur.execute("SELECT COUNT(*) FROM pdf_uploads WHERE status = 'completed'")
                total_successful = cur.fetchone()[0]

                cur.execute(
                    "SELECT COUNT(*) FROM pdf_uploads WHERE status IN ('failed','error')"
                )
                total_failed = cur.fetchone()[0]

        return {
            "total_users": total_users,
            "total_pdfs_uploaded": total_uploads,
            "total_jobs": total_jobs,
            "total_successful_jobs": total_successful,
            "total_failed_jobs": total_failed,
        }
    except Exception as e:
        print(f"get_admin_stats db error: {e}")
        db = _read_local_db()
        users = db.get("users", [])
        uploads = db.get("pdf_uploads", [])
        return {
            "total_users": len(users),
            "total_pdfs_uploaded": len(uploads),
            "total_jobs": len(uploads),
            "total_successful_jobs": len([u for u in uploads if u.get("status") == "completed"]),
            "total_failed_jobs": len([u for u in uploads if u.get("status") in ("failed", "error")]),
        }


# ---------------------------------------------------------------------------
# Admin report
# ---------------------------------------------------------------------------

def get_new_users_in_range(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT * FROM profiles
                WHERE created_at >= %s AND created_at <= %s
                ORDER BY created_at DESC
                """,
                (start_date, end_date),
            )
            return [_serialize_dates(r) for r in _rows_to_dicts(cur)]


def get_admin_report_pdf(
    days: int = 7,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> bytes:
    import fitz

    if start_date and end_date:
        cutoff_start = start_date + "T00:00:00"
        cutoff_end = end_date + "T23:59:59"
    else:
        cutoff_end = datetime.now(timezone.utc).isoformat()
        cutoff_start = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    def count_in(table: str, column: str, **filters) -> int:
        clauses = [f"{column} >= %s", f"{column} <= %s"]
        params: list = [cutoff_start, cutoff_end]
        for k, v in filters.items():
            if isinstance(v, list):
                clauses.append(f"{k} = ANY(%s)")
                params.append(v)
            else:
                clauses.append(f"{k} = %s")
                params.append(v)
        sql = f"SELECT COUNT(*) FROM {table} WHERE {' AND '.join(clauses)}"
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return cur.fetchone()[0]

    new_users_list = get_new_users_in_range(cutoff_start, cutoff_end)
    new_users_count = len(new_users_list)
    uploads_count = count_in("pdf_uploads", "uploaded_at")
    completed = count_in("pdf_uploads", "uploaded_at", status="completed")
    failed = count_in("pdf_uploads", "uploaded_at", status=["failed", "error"])

    display_start = cutoff_start[:10]
    display_end = cutoff_end[:10]

    DARK_NAVY  = (0.07, 0.10, 0.35)
    MID_BLUE   = (0.17, 0.19, 0.55)
    GREEN      = (0.10, 0.60, 0.25)
    RED        = (0.80, 0.20, 0.18)
    GREY       = (0.50, 0.50, 0.50)
    LIGHT_GREY = (0.93, 0.94, 0.95)
    WHITE      = (1.00, 1.00, 1.00)
    BLACK      = (0.12, 0.12, 0.12)
    MID_GREY   = (0.40, 0.40, 0.40)

    doc = fitz.Document()
    page = doc.new_page(width=595, height=842)
    y = 30
    left = 40
    right = 555
    page_w = 595

    def text(x, y_, s, size=11, bold=False, color=BLACK, fontname="helv"):
        page.insert_text(fitz.Point(x, y_), s, fontsize=size, fontname=fontname, color=color)

    def draw_rect(x, y_, w, h, fill=None, stroke=None, width=0.5):
        r = fitz.Rect(x, y_, x + w, y_ + h)
        if fill:
            page.draw_rect(r, color=fill, fill=fill, width=0)
        if stroke:
            page.draw_rect(r, color=stroke, width=width, fill=None)

    def divider(y_, color=(0.85, 0.85, 0.85)):
        page.draw_line(fitz.Point(left, y_), fitz.Point(right, y_), color=color, width=0.5)

    draw_rect(0, 0, page_w, 6, fill=DARK_NAVY)
    text(left, y, "New Users Report", size=22, bold=True, color=DARK_NAVY)
    y += 10
    text(left, y, f"Period: {display_start} to {display_end}", size=10, color=MID_GREY)
    text(300, y, f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}", size=8, color=MID_GREY)
    y += 18
    divider(y, (0.75, 0.75, 0.75))
    y += 14

    text(left, y, "SUMMARY", size=13, bold=True, color=DARK_NAVY)
    y += 18

    card_w = 118
    card_h = 56
    gap = 10
    total_w = card_w * 4 + gap * 3
    start_x = left + (right - left - total_w) / 2

    summary_cards = [
        ("New Users", str(new_users_count), (0.85, 0.87, 0.95), MID_BLUE),
        ("Total Uploads", str(uploads_count), (0.85, 0.95, 0.85), GREEN),
        ("Completed", str(completed), (0.90, 0.97, 0.90), GREEN),
        ("Failed", str(failed), (0.97, 0.88, 0.88), RED),
    ]
    for i, (lbl, val, bg, fg) in enumerate(summary_cards):
        cx = start_x + i * (card_w + gap)
        draw_rect(cx, y, card_w, card_h, fill=bg)
        draw_rect(cx, y, card_w, 4, fill=fg)
        text(cx + 10, y + 18, lbl, size=7, color=MID_GREY)
        text(cx + 10, y + 40, val, size=18, bold=True, color=fg)

    y += card_h + 16
    divider(y)
    y += 14

    text(left, y, f"NEW USERS ({new_users_count})", size=13, bold=True, color=DARK_NAVY)
    y += 20

    col_specs = [
        (150, "Name", "left"),
        (180, "Email", "left"),
        (100, "Organization", "left"),
        (85, "Joined", "right"),
    ]
    table_left = left
    table_right = left + sum(c[0] for c in col_specs)

    draw_rect(table_left, y - 4, table_right - table_left, 22, fill=DARK_NAVY)
    cx = table_left
    for cw, chdr, align in col_specs:
        x_pos = cx + 8 if align == "left" else cx + cw - len(chdr) * 5 - 4
        text(x_pos, y + 5, chdr, size=8, bold=True, color=WHITE)
        cx += cw
    y += 22

    for idx, u in enumerate(new_users_list):
        name = f"{u.get('first_name', '')} {u.get('last_name', '')}".strip() or "Unknown"
        if len(name) > 28:
            name = name[:25] + "..."
        email_val = u.get("email", "-")
        if len(email_val) > 30:
            email_val = email_val[:27] + "..."
        org = u.get("organization", "-")
        if len(org) > 18:
            org = org[:15] + "..."
        joined = u.get("created_at", "")
        if joined:
            try:
                joined = datetime.fromisoformat(joined).strftime("%b %d, %Y")
            except Exception:
                joined = str(joined)[:10]

        if idx % 2 == 0:
            draw_rect(table_left, y - 3, table_right - table_left, 18, fill=(0.97, 0.97, 0.98))

        cx = table_left
        text(cx + 8, y + 5, name, size=7, color=BLACK)
        cx += col_specs[0][0]
        text(cx + 8, y + 5, email_val, size=7, color=BLACK)
        cx += col_specs[1][0]
        text(cx + 8, y + 5, org, size=7, color=MID_GREY)
        cx += col_specs[2][0]
        text(cx + col_specs[3][0] - len(joined) * 4 - 4, y + 5, joined, size=7, color=MID_GREY)

        y += 21
        if y > 790:
            page = doc.new_page(width=595, height=842)
            y = 30

    if not new_users_list:
        text(left + 20, y + 10, "No new users registered in this period.", size=10, color=MID_GREY)
        y += 30

    for pn in range(doc.page_count):
        pg = doc[pn]
        w, h = pg.rect.width, pg.rect.height
        text(left, h - 20, f"Ethosh Admin Report | Page {pn + 1} of {doc.page_count}", size=7, color=(0.65, 0.65, 0.65))
        draw_rect(0, h - 14, w, 3, fill=DARK_NAVY)

    buf = doc.write()
    doc.close()
    return buf


# ---------------------------------------------------------------------------
# Schema Auto-Initialization
# ---------------------------------------------------------------------------

_schema_initialized = False

def init_db_schema():
    """Ensure user_dictionary and user_activity tables exist in PostgreSQL."""
    global _schema_initialized
    if _schema_initialized:
        return
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS user_dictionary (
                        id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
                        user_id     TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                        word        TEXT        NOT NULL,
                        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT user_dictionary_user_word_unique UNIQUE (user_id, word)
                    );
                    CREATE INDEX IF NOT EXISTS user_dictionary_user_id_idx ON user_dictionary (user_id);
                    CREATE INDEX IF NOT EXISTS user_dictionary_word_idx ON user_dictionary (word);

                    CREATE TABLE IF NOT EXISTS user_activity (
                        id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
                        user_id       TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                        action_type   TEXT        NOT NULL,
                        document_name TEXT        NOT NULL DEFAULT '',
                        details       JSONB,
                        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS user_activity_user_id_idx ON user_activity (user_id);
                    CREATE INDEX IF NOT EXISTS user_activity_created_at_idx ON user_activity (created_at DESC);
                    CREATE INDEX IF NOT EXISTS user_activity_action_type_idx ON user_activity (action_type);
                """)
        _schema_initialized = True
        print("[pg_service] Schema initialized: user_dictionary and user_activity ready.")
    except Exception as e:
        _schema_initialized = True
        print(f"[pg_service] Schema auto-init skipped (DB unreachable/offline): {e}")




# ---------------------------------------------------------------------------
# User-Specific Dictionary Operations
# ---------------------------------------------------------------------------

def get_user_dictionary(user_id: str) -> List[Dict[str, Any]]:
    """Get all custom dictionary words for the given user."""
    init_db_schema()
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, user_id, word, created_at
                    FROM user_dictionary
                    WHERE user_id = %s
                    ORDER BY word ASC
                    """,
                    (user_id,),
                )
                return [_serialize_dates(r) for r in _rows_to_dicts(cur)]
    except Exception as e:
        # Local dev fallback
        db = _read_local_db()
        items = [w for w in db.get("user_dictionary", []) if w.get("user_id") == user_id]
        items.sort(key=lambda x: x.get("word", "").lower())
        return items


def get_user_dictionary_words(user_id: Optional[str]) -> set[str]:
    """Get a set of approved lowercase words for the user (for hygiene filtering)."""
    if not user_id:
        return set()
    items = get_user_dictionary(user_id)
    return {w["word"].lower().strip() for w in items if w.get("word")}


def add_user_dictionary_word(user_id: str, word: str) -> Dict[str, Any]:
    """Add a word to the user's custom dictionary preserving exact casing."""
    clean_word = word.strip()
    if not clean_word:
        raise ValueError("Word cannot be empty")

    init_db_schema()
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id FROM user_dictionary
                    WHERE user_id = %s AND LOWER(word) = LOWER(%s)
                    """,
                    (user_id, clean_word),
                )
                existing_row = cur.fetchone()
                if existing_row:
                    cur.execute(
                        """
                        UPDATE user_dictionary
                        SET word = %s
                        WHERE id = %s
                        RETURNING id, user_id, word, created_at
                        """,
                        (clean_word, existing_row[0]),
                    )
                    row = cur.fetchone()
                else:
                    cur.execute(
                        """
                        INSERT INTO user_dictionary (user_id, word)
                        VALUES (%s, %s)
                        ON CONFLICT (user_id, word) DO UPDATE SET word = EXCLUDED.word
                        RETURNING id, user_id, word, created_at
                        """,
                        (user_id, clean_word),
                    )
                    row = cur.fetchone()
                if row:
                    res = _serialize_dates(_row_to_dict(cur, row))
                    # Also log to user activity
                    log_user_activity(user_id, "add_dictionary", "", {"word": clean_word})
                    return res
    except Exception as e:
        # Local fallback
        import uuid
        db = _read_local_db()
        dict_list = db.setdefault("user_dictionary", [])
        existing = next((w for w in dict_list if w.get("user_id") == user_id and w.get("word", "").lower() == clean_word.lower()), None)
        if existing:
            existing["word"] = clean_word
            _write_local_db(db)
            log_user_activity(user_id, "add_dictionary", "", {"word": clean_word})
            return existing
        entry = {
            "id": f"dict_{uuid.uuid4().hex[:8]}",
            "user_id": user_id,
            "word": clean_word,
            "created_at": now_iso
        }
        dict_list.append(entry)
        _write_local_db(db)
        log_user_activity(user_id, "add_dictionary", "", {"word": clean_word})
        return entry


def remove_user_dictionary_word(user_id: str, word_or_id: str) -> bool:
    """Remove a word from the user's dictionary by word or id (case-insensitive for words)."""
    target = word_or_id.strip()
    if not target:
        return False
    init_db_schema()
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM user_dictionary
                    WHERE user_id = %s AND (id = %s OR LOWER(word) = LOWER(%s))
                    """,
                    (user_id, word_or_id, target),
                )
                deleted = cur.rowcount > 0
                if deleted:
                    log_user_activity(user_id, "remove_dictionary", "", {"word": target})
                return deleted
    except Exception as e:
        # Local fallback
        db = _read_local_db()
        dict_list = db.get("user_dictionary", [])
        initial_len = len(dict_list)
        db["user_dictionary"] = [
            w for w in dict_list
            if not (w.get("user_id") == user_id and (w.get("id") == word_or_id or w.get("word", "").lower() == target.lower()))
        ]
        if len(db["user_dictionary"]) < initial_len:
            _write_local_db(db)
            log_user_activity(user_id, "remove_dictionary", "", {"word": target})
            return True
        return False


# ---------------------------------------------------------------------------
# User-Specific Activity & History Operations
# ---------------------------------------------------------------------------

def log_user_activity(
    user_id: str,
    action_type: str,
    document_name: str = "",
    details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Persist a user action/review event."""
    init_db_schema()
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO user_activity (user_id, action_type, document_name, details)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id, user_id, action_type, document_name, details, created_at
                    """,
                    (user_id, action_type, document_name or "", json.dumps(details or {})),
                )
                row = cur.fetchone()
                if row:
                    return _serialize_dates(_row_to_dict(cur, row))
    except Exception as e:
        # Local fallback
        import uuid
        db = _read_local_db()
        act_list = db.setdefault("user_activity", [])
        entry = {
            "id": f"act_{uuid.uuid4().hex[:8]}",
            "user_id": user_id,
            "action_type": action_type,
            "document_name": document_name or "",
            "details": details or {},
            "created_at": now_iso
        }
        act_list.insert(0, entry) # newest first
        _write_local_db(db)
        return entry


def get_user_activities(
    user_id: str,
    action_type: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    is_admin: bool = False,
    all_users: bool = False,
) -> List[Dict[str, Any]]:
    """Retrieve chronologically sorted activity records for the user."""
    init_db_schema()
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                query = "SELECT id, user_id, action_type, document_name, details, created_at FROM user_activity WHERE 1=1"
                params: List[Any] = []

                if not (all_users and is_admin):
                    query += " AND user_id = %s"
                    params.append(user_id)

                if action_type:
                    query += " AND action_type = %s"
                    params.append(action_type)

                if search:
                    query += " AND (document_name ILIKE %s OR action_type ILIKE %s)"
                    term = f"%{search}%"
                    params.extend([term, term])

                query += " ORDER BY created_at DESC LIMIT %s OFFSET %s"
                params.extend([limit, offset])

                cur.execute(query, tuple(params))
                return [_serialize_dates(r) for r in _rows_to_dicts(cur)]
    except Exception as e:
        # Local fallback
        db = _read_local_db()
        acts = db.get("user_activity", [])
        if not (all_users and is_admin):
            acts = [a for a in acts if a.get("user_id") == user_id]
        if action_type:
            acts = [a for a in acts if a.get("action_type") == action_type]
        if search:
            st = search.lower()
            acts = [a for a in acts if st in a.get("document_name", "").lower() or st in a.get("action_type", "").lower()]
        acts.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return acts[offset:offset + limit]

