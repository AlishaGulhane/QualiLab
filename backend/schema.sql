-- =============================================================================
-- PostgreSQL schema for QualiLabs QC Tool
-- Run once against a fresh database:
--   psql $DATABASE_URL -f schema.sql
-- =============================================================================

-- Enable the uuid-ossp extension so gen_random_uuid() works on older PG versions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles (users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    email           TEXT        NOT NULL UNIQUE,
    first_name      TEXT        NOT NULL DEFAULT '',
    last_name       TEXT        NOT NULL DEFAULT '',
    organization    TEXT        NOT NULL DEFAULT '',
    role            TEXT        NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    password_hash   TEXT,                          -- bcrypt hash; NULL for OAuth-only accounts
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (email);
CREATE INDEX IF NOT EXISTS profiles_created_at_idx ON profiles (created_at DESC);

-- ---------------------------------------------------------------------------
-- pdf_uploads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdf_uploads (
    id                  TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id             TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    filename            TEXT        NOT NULL,
    s3_url              TEXT,
    file_type           TEXT,
    brand_guideline     TEXT        NOT NULL DEFAULT '',
    document_content    TEXT,
    file_size           BIGINT,
    status              TEXT        NOT NULL DEFAULT 'uploaded',
    validation_summary  JSONB,
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pdf_uploads_user_id_idx    ON pdf_uploads (user_id);
CREATE INDEX IF NOT EXISTS pdf_uploads_status_idx     ON pdf_uploads (status);
CREATE INDEX IF NOT EXISTS pdf_uploads_uploaded_at_idx ON pdf_uploads (uploaded_at DESC);

-- ---------------------------------------------------------------------------
-- feedback
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    upload_id   TEXT        NOT NULL REFERENCES pdf_uploads(id) ON DELETE CASCADE,
    rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feedback_user_id_idx   ON feedback (user_id);
CREATE INDEX IF NOT EXISTS feedback_upload_id_idx ON feedback (upload_id);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback (created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed: create the first ADMIN account (optional — remove if not needed)
-- Change the values below before running, or delete this block entirely.
-- ---------------------------------------------------------------------------
-- INSERT INTO profiles (id, email, first_name, last_name, organization, role, password_hash)
-- VALUES (
--     gen_random_uuid()::text,
--     'admin@example.com',
--     'Admin',
--     'User',
--     'QualiLabs',
--     'ADMIN',
--     -- generate with: python -c "import bcrypt; print(bcrypt.hashpw(b'changeme', bcrypt.gensalt()).decode())"
--     '$2b$12$REPLACE_WITH_REAL_BCRYPT_HASH'
-- )
-- ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- user_dictionary (user-scoped approved words)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_dictionary (
    id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id     TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    word        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_dictionary_user_word_unique UNIQUE (user_id, word)
);

CREATE INDEX IF NOT EXISTS user_dictionary_user_id_idx ON user_dictionary (user_id);
CREATE INDEX IF NOT EXISTS user_dictionary_word_idx ON user_dictionary (word);

-- ---------------------------------------------------------------------------
-- user_activity (user-scoped activity and review history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_activity (
    id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id       TEXT        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    action_type   TEXT        NOT NULL, -- 'upload', 'review', 'ignore_error', 'restore_error', 'add_dictionary', 'remove_dictionary', 'download_report'
    document_name TEXT        NOT NULL DEFAULT '',
    details       JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_activity_user_id_idx ON user_activity (user_id);
CREATE INDEX IF NOT EXISTS user_activity_created_at_idx ON user_activity (created_at DESC);
CREATE INDEX IF NOT EXISTS user_activity_action_type_idx ON user_activity (action_type);
