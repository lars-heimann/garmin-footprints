ALTER TABLE invites ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN expires_at TEXT;
ALTER TABLE jobs ADD COLUMN published_at TEXT;
ALTER TABLE jobs ADD COLUMN deleted_at TEXT;
ALTER TABLE jobs ADD COLUMN delete_token_hash TEXT;

CREATE INDEX IF NOT EXISTS jobs_slug_status_idx ON jobs (slug, status);
CREATE INDEX IF NOT EXISTS jobs_delete_token_hash_idx ON jobs (delete_token_hash);
CREATE INDEX IF NOT EXISTS jobs_expires_at_idx ON jobs (expires_at);
