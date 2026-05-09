DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sync_jobs_status_check'
  ) THEN
    ALTER TABLE sync_jobs DROP CONSTRAINT sync_jobs_status_check;
  END IF;
END $$;

ALTER TABLE sync_jobs
ADD CONSTRAINT sync_jobs_status_check
CHECK (status IN ('received', 'processing', 'processed', 'failed', 'conflict', 'retrying'));

ALTER TABLE sync_jobs
ADD COLUMN IF NOT EXISTS source_device_id TEXT NULL,
ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS last_error_code TEXT NULL,
ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS processed_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE sync_conflicts
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'resolved', 'ignored')),
ADD COLUMN IF NOT EXISTS resolution_action TEXT NULL,
ADD COLUMN IF NOT EXISTS resolution_note TEXT NULL,
ADD COLUMN IF NOT EXISTS resolved_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_next_retry
ON sync_jobs (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_status
ON sync_conflicts (status, created_at DESC);
