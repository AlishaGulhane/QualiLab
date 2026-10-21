import json
import os
from google.cloud import firestore as google_firestore
from google.oauth2 import service_account

_db = None

APPROVED_WORDS_COLLECTION = "approved_words"
APPROVED_PRODUCT_NAMES_COLLECTION = "approved_product_names"


def _get_db():
    global _db
    if _db is not None:
        return _db

    cred_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    cred_path = os.getenv("FIREBASE_CREDENTIALS_PATH")

    if cred_json:
        cred_dict = json.loads(cred_json)
        creds = service_account.Credentials.from_service_account_info(cred_dict)
        project = cred_dict.get("project_id", "qualilabs")
    elif cred_path:
        creds = service_account.Credentials.from_service_account_file(cred_path)
        with open(cred_path) as f:
            project = json.load(f).get("project_id", "qualilabs")
    else:
        creds = None
        project = "qualilabs"

    _db = google_firestore.Client(project=project, credentials=creds, database="qualilabs")
    return _db


def get_approved_words() -> set[str]:
    db = _get_db()
    docs = db.collection(APPROVED_WORDS_COLLECTION).stream()
    return {doc.id for doc in docs}


def add_approved_word(word: str) -> None:
    db = _get_db()
    db.collection(APPROVED_WORDS_COLLECTION).document(word.lower()).set({"word": word.lower()})


def get_approved_product_names() -> set[str]:
    db = _get_db()
    docs = db.collection(APPROVED_PRODUCT_NAMES_COLLECTION).stream()
    return {doc.id for doc in docs}


def add_approved_product_name(name: str) -> None:
    db = _get_db()
    db.collection(APPROVED_PRODUCT_NAMES_COLLECTION).document(name).set({"name": name})
