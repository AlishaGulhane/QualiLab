from typing import Optional
import os
import uuid
import tempfile
import shutil

# In-memory map: file_id -> {path, filename, size_mb}
_store: dict = {}

TEMP_DIR = os.path.join(tempfile.gettempdir(), "hygiene_uploads")
os.makedirs(TEMP_DIR, exist_ok=True)


def save_file(filename: str, data: bytes) -> dict:
    file_id = str(uuid.uuid4())
    dest = os.path.join(TEMP_DIR, f"{file_id}_{filename}")
    with open(dest, "wb") as f:
        f.write(data)
    size_mb = round(len(data) / (1024 * 1024), 2)
    _store[file_id] = {"path": dest, "filename": filename, "size_mb": size_mb}
    return {"file_id": file_id, "size_mb": size_mb}


def get_file(file_id: str) -> Optional[dict]:
    return _store.get(file_id)


def read_file(file_id: str) -> Optional[bytes]:
    info = _store.get(file_id)
    if not info:
        return None
    with open(info["path"], "rb") as f:
        return f.read()


def set_preview_pdf(file_id: str, preview_pdf: bytes):
    """Store rendered preview PDF bytes for non-PDF documents without altering originals."""
    if file_id in _store:
        _store[file_id]["preview_pdf"] = preview_pdf


def get_preview_pdf(file_id: str) -> Optional[bytes]:
    """Get cached rendered preview PDF bytes for non-PDF documents."""
    info = _store.get(file_id)
    if not info:
        return None
    return info.get("preview_pdf")
