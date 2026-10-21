import uuid
from typing import Optional

# job_id -> {status, progress, result, error}
_jobs: dict = {}

# Stored separately — bytes are not JSON-serializable and must not enter _jobs
_job_pdfs: dict = {}


def create_job() -> str:
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "queued", "progress": 0, "result": None, "error": None}
    return job_id


def get_job(job_id: str) -> Optional[dict]:
    return _jobs.get(job_id)


def update_job(job_id: str, status: str, progress: int = 0, result=None, error: str = None):
    if job_id in _jobs:
        _jobs[job_id].update({"status": status, "progress": progress, "result": result, "error": error})


def cancel_job(job_id: str):
    if job_id in _jobs:
        _jobs[job_id]["status"] = "cancelled"


def set_job_annotated_pdf(job_id: str, pdf_bytes: bytes):
    _job_pdfs[job_id] = pdf_bytes


def get_job_annotated_pdf(job_id: str) -> Optional[bytes]:
    return _job_pdfs.get(job_id)
