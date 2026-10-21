import os
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv


def _load_env_file() -> Optional[str]:
    """Load .env from common locations (local dev, EC2 flat deploy, backend/ subfolder)."""
    backend_dir = Path(__file__).resolve().parent
    project_root = backend_dir.parent

    candidates = [
        Path.cwd() / ".env",
        backend_dir / ".env",
        project_root / ".env",
    ]

    seen: set[Path] = set()
    loaded_from: Optional[str] = None
    for path in candidates:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        load_dotenv(resolved, override=True)
        loaded_from = str(resolved)

    if loaded_from is None:
        load_dotenv()

    # Debug: log whether required vars were actually set
    db = os.environ.get("DATABASE_URL", "")
    js = os.environ.get("JWT_SECRET", "")
    loaded = loaded_from or "process environment"
    if db and js:
        print(f"[config] Database env vars loaded from {loaded}")
    else:
        missing = [k for k, v in [("DATABASE_URL", db), ("JWT_SECRET", js)] if not v]
        print(f"[config] .env loaded from {loaded} but vars STILL missing: {missing}")

    return loaded_from


ENV_FILE = _load_env_file()

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

# Firebase — provide one of these to enable Firestore persistence (for approved words only)
FIREBASE_CREDENTIALS_JSON = os.getenv("FIREBASE_CREDENTIALS_JSON")
FIREBASE_CREDENTIALS_PATH = os.getenv("FIREBASE_CREDENTIALS_PATH")

AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_SESSION_TOKEN = os.getenv("AWS_SESSION_TOKEN")

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
# Format: postgresql://user:password@host:5432/dbname
# or:     postgresql://user:password@host:5432/dbname?sslmode=require
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

# ---------------------------------------------------------------------------
    # JWT (custom auth)
# ---------------------------------------------------------------------------
JWT_SECRET = os.getenv("JWT_SECRET", "").strip()
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "24"))

# ---------------------------------------------------------------------------
# S3 (separate credentials from Bedrock)
# ---------------------------------------------------------------------------
S3_AWS_ACCESS_KEY_ID = os.getenv("S3_AWS_ACCESS_KEY_ID")
S3_AWS_SECRET_ACCESS_KEY = os.getenv("S3_AWS_SECRET_ACCESS_KEY")
S3_AWS_REGION = os.getenv("S3_AWS_REGION", "us-east-1")
S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME")

# Primary: Amazon Nova Pro (vision, AWS native)
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")

MAX_FILE_SIZE_MB = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
LLM_REPEAT_PASSES = int(os.getenv("LLM_REPEAT_PASSES", "1"))
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", "0.0"))
ALLOWED_ORIGINS = ["*"]

# Development authentication bypass (strictly local development; default false in production)
DEV_BYPASS_AUTH = os.getenv("DEV_BYPASS_AUTH", "false").lower() in ("true", "1", "yes")


def db_configured() -> bool:
    return bool(DATABASE_URL and JWT_SECRET)


def missing_config_vars() -> list[str]:
    missing = []
    if not DATABASE_URL:
        missing.append("DATABASE_URL")
    if not JWT_SECRET:
        missing.append("JWT_SECRET")
    return missing
