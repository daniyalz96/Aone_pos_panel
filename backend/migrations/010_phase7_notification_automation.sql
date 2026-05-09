ALTER TABLE notifications
ADD COLUMN IF NOT EXISTS dedupe_key TEXT NULL,
ADD COLUMN IF NOT EXISTS source_type TEXT NULL,
ADD COLUMN IF NOT EXISTS source_id UUID NULL,
ADD COLUMN IF NOT EXISTS metadata JSONB NULL,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe_open
ON notifications (dedupe_key)
WHERE dedupe_key IS NOT NULL AND acknowledged = FALSE;

CREATE INDEX IF NOT EXISTS idx_notifications_type_created_at
ON notifications (type, created_at DESC);
