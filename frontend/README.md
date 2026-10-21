# QualiLabs QC Tool — Document Hygiene Checker

AI-powered document quality control system that automatically validates documents for spelling, grammar, title case, and spacing issues using AWS Bedrock LLMs. Provides interactive annotated previews, downloadable reports, and an admin dashboard.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Features](#features)
  - [Core Validation](#core-validation)
  - [Document Processing](#document-processing)
  - [Interactive Preview](#interactive-preview)
  - [Scoring & Reporting](#scoring--reporting)
  - [Administration](#administration)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [Document Upload & Processing](#document-upload--processing)
  - [QC Validation](#qc-validation)
  - [Admin Endpoints](#admin-endpoints)
  - [User Endpoints](#user-endpoints)
- [Database Schema](#database-schema)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running Locally](#running-locally)
- [Deployment](#deployment)
- [Security Notes](#security-notes)

---

## Overview

QualiLabs QC Tool automates document quality assurance for regulated industries. Users upload PDFs, images, DOCX, or text files; the system runs multiple AI validation passes via AWS Bedrock and returns an interactive annotated document with detected issues overlaid directly on the page. Each issue is color-coded by category with tooltip details including suggestions for correction.

Averaging by category and normalizing to a 0–100 score, the system generates a pass/fail verdict (Excellent / Good / Needs Work / Poor) with breakdowns by severity.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3.13+, FastAPI, Uvicorn |
| **Frontend** | Vanilla HTML/CSS/JS (ES Modules, no bundler) |
| **LLM Provider** | AWS Bedrock (Amazon Nova Pro, Claude 3.5 Sonnet, Claude 3 Haiku, Amazon Nova Lite) |
| **Primary Database** | Supabase (PostgreSQL + Auth) |
| **Document Store** | Firebase Firestore (approved words / product names) |
| **File Storage** | AWS S3 |
| **Auth** | Supabase Auth (JWT, email/password) |
| **OCR** | Tesseract + LLM-based image transcription |
| **PDF Processing** | PyMuPDF (fitz) |
| **Image Processing** | Pillow |
| **DOCX Processing** | python-docx |
| **Spell Checking** | pyspellchecker (local fallback) |

---

## Architecture

```
User Browser (frontend/)
       │
       │ HTTPS
       ▼
FastAPI Backend (backend/)
       │
       ├── Supabase Auth ────── PostgreSQL (profiles, pdf_uploads, feedback)
       ├── AWS Bedrock ──────── LLM validation passes
       ├── Firebase Firestore ─ Approved words / product names
       └── AWS S3 ───────────── Uploaded document storage
```

- Frontend static files served from S3/CloudFront or locally.
- Backend runs as a Uvicorn ASGI server.
- Background validation jobs run in-process with an in-memory queue (`job_manager.py`).
- Annotated PDFs are generated in-memory and served as byte-stream downloads.

---

## Features

### Core Validation

**Spelling Errors** — Detects misspelled words via LLM analysis with false-positive filtering for acronyms, brands, single-character tokens, and approved dictionaries.

**Grammar Mistakes** — Identifies subject-verb agreement, tense, punctuation, article misuse, and sentence structure problems through LLM grammar passes.

**Title Case Violations** — Flags headings and titles that do not follow title-case capitalization rules.

**Double Spacing** — Detects consecutive space characters between words anywhere in the document.

**Abbreviation Pre-Pass** — Before validation, the system extracts all defined abbreviations (e.g. "QC (Quality Control)") so they are not flagged as spelling errors in subsequent passes.

**Approved Words Dictionary** — A Firestore-backed list of words that are skipped during spelling checks. Managed via admin API endpoints.

**Approved Product Names** — A separate Firestore collection for product/brand name exemptions.

**OCR for Images** — Scanned PDF pages and standalone images are transcribed via LLM-based OCR before validation.

### Document Processing

| Format | Support |
|---|---|
| PDF | Full support with page rendering, text extraction, font extraction, zone detection |
| Images | PNG, JPEG, WebP, GIF — up to 20 MB |
| DOCX | Text extraction via python-docx |
| TXT | Plain text |
| **Max upload** | 50 MB (configurable via `MAX_FILE_SIZE_MB`) |

**Zone Detection** — Analyzes each page to identify text blocks (blue overlay) and image regions (orange overlay), useful for layout validation.

**Font Extraction** — Extracts every font used in a PDF, listing font names, types, and embedding status. Supports highlighting all occurrences of a specific font on a given page.

**S3 Persistence** — Authenticated users' uploads are stored in AWS S3 and linked to their Supabase `pdf_uploads` record.

### Interactive Preview

The web-based document viewer provides:

- **Page-by-page navigation** with thumbnails and page controls.
- **Color-coded annotation boxes** overlaid on each detected issue:
  - Red — Spelling error
  - Green — Grammar mistake
  - Blue — Double spacing
  - Purple — Title case violation
  - Orange — Image region
- **Hover tooltips** — Hover any box to see category, original text, suggestion, and description.
- **Pinned, draggable tooltips** — Click a box to pin its tooltip; drag it anywhere on the page.
- **Zoom controls** — Fit-to-page, fit-to-width, and percentage zoom slider.
- **Canvas-based rendering** — Each page is rendered on an HTML Canvas with overlaid SVG annotations for crisp, scalable previews.

### Scoring & Reporting

| Metric | Calculation |
|---|---|
| Error | −8 points each |
| Warning | −3 points each |
| Suggestion | 0 points (informational only) |
| **Overall Score** | Max(0, 100 − Σ penalties), normalized 0–100 |
| **Verdict** | ≥90 Excellent, ≥70 Good, ≥50 Needs Work, <50 Poor |

- Deduplication across multiple LLM passes prevents the same issue from being counted twice.
- Results include a full issue list with category, severity, location, original text, and suggestion.

**Downloadable PDFs:**

- **Annotated PDF** — The original document with colored annotation boxes drawn directly on each page.
- **Legend PDF** — A summary page listing every detected issue with page references, categories, and suggestions.

### Administration

**Admin Dashboard** (`admin.html`) — Protected by role-based access (`ADMIN` role required).

- **Statistics panel** — Total users, total uploads, total jobs run, average score.
- **User management** — View all registered users with email, name, organization, and role.
- **Upload tracking** — Browse all user uploads with filename, type, status, and timestamps.
- **Feedback viewer** — Read user-submitted ratings (1–5 stars) and comments.

**Approved Words & Product Names UI** — Add/remove entries directly from the admin page.

### Feedback System

After validation, users can submit a 1–5 star rating with an optional comment. Feedback is linked to both the user and the specific upload, and is viewable in the admin dashboard.

### User Upload History

Authenticated users can browse their own past uploads with status, date, and result summary.

### Dark/Light Mode

The UI includes a theme toggle (currently locked to light mode in code).

---

## API Reference

Base URL: `http://localhost:8000` (dev) or `https://qualilab2.ethosh.net` (prod)

### Authentication

Supabase Auth JWT tokens are sent as `Authorization: Bearer <token>` headers.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Health check, returns active Bedrock model ID |
| `GET` | `/api/auth/config` | — | Returns Supabase URL + anon key for frontend bootstrap |
| `POST` | `/api/auth/register` | — | Register new user `{email, password, first_name, last_name, organization}` |
| `POST` | `/api/auth/login` | — | Login `{email, password}`, returns `{user, session}` |
| `GET` | `/api/auth/profile` | Bearer | Returns current user's profile |

### Document Upload & Processing

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/pdf/upload` | Optional | Upload file (multipart/form-data). If authenticated, stores in S3 + Supabase. Returns `{file_id}`. |
| `GET` | `/api/pdf/zones/{file_id}` | — | Returns page zones (text blocks, image regions) as JSON with bounding boxes |
| `GET` | `/api/pdf/fonts/{file_id}` | — | Returns all fonts used in the PDF |
| `GET` | `/api/pdf/fonts/{file_id}/highlight` | — | Returns bounding boxes for a specific font on a page (query: `{font, page}`) |

### QC Validation

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/qc/start_validate` | — | Start background validation job. Body: `{file_id, brand_guideline?}`. Returns `{job_id}`. |
| `GET` | `/api/qc/status/{job_id}` | — | Poll job status. Returns `{status, progress, result?, error?}`. |
| `POST` | `/api/qc/cancel/{job_id}` | — | Cancel a running job |
| `GET` | `/api/qc/annotated/{job_id}` | — | Download annotated PDF as `application/pdf` |
| `GET` | `/api/qc/legend/{job_id}` | — | Download legend PDF as `application/pdf` |

### Admin Endpoints

Requires `ADMIN` role. Bearer token required.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/stats` | Dashboard statistics (user count, upload count, job count, average score) |
| `GET` | `/api/admin/users` | List all users |
| `GET` | `/api/admin/uploads` | List all uploads with user details |
| `GET` | `/api/admin/feedback` | List all feedback entries |
| `GET` | `/api/admin/approved_words` | List approved (ignored) words |
| `POST` | `/api/admin/approved_words` | Add a word to approved list `{word}` |
| `GET` | `/api/admin/approved_product_names` | List approved product names |
| `POST` | `/api/admin/approved_product_names` | Add a product name `{name}` |

### User Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/user/uploads` | Bearer | Current user's upload history |
| `POST` | `/api/feedback` | Bearer | Submit feedback `{upload_id, rating (1–5), comment?}` |

---

## Database Schema

### Supabase (PostgreSQL)

**`profiles`** — Extends Supabase Auth users

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | References `auth.users.id` |
| `email` | TEXT UNIQUE | |
| `first_name` | TEXT | |
| `last_name` | TEXT | |
| `organization` | TEXT | |
| `role` | TEXT | `USER` or `ADMIN`, default `USER` |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**`pdf_uploads`** — User document uploads

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `user_id` | UUID FK | References `profiles.id`, ON DELETE CASCADE |
| `filename` | TEXT | |
| `s3_url` | TEXT | S3 object URL |
| `file_type` | TEXT | MIME type |
| `brand_guideline` | TEXT | Optional brand guide |
| `document_content` | TEXT | Extracted text |
| `status` | TEXT | `uploaded`, `processing`, `completed`, `failed` |
| `uploaded_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |

**`feedback`** — User ratings & comments

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Auto-generated |
| `user_id` | UUID FK | References `profiles.id`, ON DELETE CASCADE |
| `upload_id` | UUID FK | References `pdf_uploads.id`, ON DELETE CASCADE |
| `rating` | INTEGER | 1–5 |
| `comment` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

### Firebase Firestore

| Collection | Document ID | Fields |
|---|---|---|
| `approved_words` | The word itself | `{word: string}` |
| `approved_product_names` | The product name | `{name: string}` |

---

## Project Structure

```
.
├── .env                          # Environment variables (gitignored)
├── .env.example                  # Environment variable template
├── .gitignore
├── supabase_setup.sql            # SQL schema for Supabase tables & RLS policies
├── README.md
│
├── backend/
│   ├── requirements.txt          # Python dependencies
│   ├── config.py                 # Configuration loader from env vars
│   ├── main.py                   # FastAPI app — all route definitions
│   ├── local_db.json             # Local persistence (gitignored)
│   ├── models/
│   │   ├── __init__.py
│   │   └── schemas.py            # Pydantic models (HygieneIssue, HygieneSummary, etc.)
│   └── services/
│       ├── __init__.py
│       ├── annotation_service.py  # PDF/image annotation (draws colored boxes)
│       ├── auth_service.py        # Supabase Auth (register, login, token verify)
│       ├── bedrock_service.py     # AWS Bedrock LLM invocation & OCR passes
│       ├── document_service.py    # PDF/DOCX/Image/Text extraction & zone detection
│       ├── file_store.py          # In-memory temp file storage
│       ├── firebase_service.py    # Firestore CRUD for approved words/product names
│       ├── hygiene_service.py     # Core validation logic (collect, dedup, score)
│       ├── job_manager.py         # Async background job queue
│       ├── s3_service.py          # AWS S3 upload
│       └── supabase_service.py    # Supabase DB CRUD
│
├── frontend/
│   ├── runtime-config.js          # Auto-detects dev/prod environment
│   ├── index.html                 # Login page
│   ├── register.html              # Registration page
│   ├── app.html                   # Main application (upload, validate, preview)
│   ├── admin.html                 # Admin dashboard
│   ├── logo/
│   │   ├── dark-logo.svg
│   │   └── ethosh-logo.png
│   ├── css/
│   │   ├── main.css               # Core application styles
│   │   ├── theme.css              # Theme/visual enhancements
│   │   └── auth.css               # Auth page styles
│   └── js/
│       ├── config.js              # Config management & fetch helpers
│       ├── config.development.js  # Dev config (localhost:8000)
│       ├── config.production.js   # Production config
│       ├── auth.js                # Supabase auth module
│       ├── main.js                # Main application logic
│       └── admin.js               # Admin dashboard logic
```

---

## Getting Started

### Prerequisites

- Python 3.13+
- Tesseract OCR (system-level, for local image OCR)
- AWS account with Bedrock access (Amazon Nova Pro or compatible model)
- Supabase project (PostgreSQL + Auth)
- Firebase project with Firestore (for approved words)
- AWS S3 bucket (for file storage)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd mock-admin

# Backend setup
cd backend
python -m venv venv
.\venv\Scripts\activate    # Windows
# source venv/bin/activate  # macOS/Linux
pip install -r requirements.txt

# Copy environment file
copy .env.example .env     # Windows
# cp .env.example .env      # macOS/Linux
```

### Configuration

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |
| `AWS_SESSION_TOKEN` | AWS session token (optional) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `S3_BUCKET_NAME` | S3 bucket for uploads |
| `BEDROCK_MODEL_ID` | Bedrock model ID (default: `amazon.nova-pro-v1:0`) |
| `MAX_FILE_SIZE_MB` | Max upload size (default: `50`) |
| `LLM_REPEAT_PASSES` | Validation passes per LLM stage (default: `1`) |
| `FIREBASE_CREDENTIALS_JSON` | Firebase service account JSON string |
| `FIREBASE_CREDENTIALS_PATH` | Path to Firebase credentials file |

### Database Setup

Run `supabase_setup.sql` in your Supabase project's SQL Editor to create the tables, RLS policies, and triggers.

### Running Locally

```bash
# Terminal 1: Backend
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: Frontend (any static server)
cd frontend
# Using Python's built-in HTTP server:
python -m http.server 5500
# Or use any other static file server
```

Open `http://localhost:5500` in your browser. The frontend auto-detects the local environment and points API calls to `localhost:8000`.

---

## Deployment

### Production Architecture

- **Frontend**: Static files hosted on S3 + CloudFront CDN, served at `qualilab.ethosh.net`
- **Backend**: FastAPI running on EC2 behind a reverse proxy at `qualilab2.ethosh.net`
- **Database**: Managed Supabase project
- **File Storage**: AWS S3
- **Approved Words**: Firebase Firestore

### Build/Deploy Steps

1. Set environment variables for production in `.env`.
2. Ensure `frontend/runtime-config.js` correctly detects the production domain.
3. Upload `frontend/` contents to your S3 bucket.
4. Run the backend with `uvicorn main:app --host 0.0.0.0 --port 8000`.
5. Set up a reverse proxy (Nginx, Caddy, etc.) with HTTPS termination pointing to the backend.

---

## Security Notes

- The `.env` file contains **live credentials** (AWS keys, Supabase service key). It is **gitignored** by default. Never commit it.
- Supabase RLS policies restrict data access: users see only their own records; admins see all.
- Admin endpoints enforce role checks at the application level (`ADMIN` role required).
- JWT tokens are validated on every authenticated request via Supabase Auth.
- File uploads are size-limited (50 MB default) and stored in S3, not on the application server.

---

## License

Proprietary — Ethosh. All rights reserved.
