CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slugs (
  slug TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  invite_code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  upload_key TEXT,
  error_code TEXT,
  error_message TEXT,
  site_url TEXT,
  raw_upload_deleted_at TEXT,
  start_date TEXT,
  max_points INTEGER
);

CREATE INDEX IF NOT EXISTS jobs_slug_idx ON jobs (slug);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
