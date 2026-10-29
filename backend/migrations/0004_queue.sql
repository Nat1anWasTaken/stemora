-- Per-user queue: work over MAX_CONCURRENT_JOBS waits as 'pending' (oldest queued_at first)
-- instead of being rejected, and the backend starts it when a slot frees up.
ALTER TABLE songs DROP CONSTRAINT songs_status_check;
ALTER TABLE songs ADD CONSTRAINT songs_status_check
    CHECK (status IN ('pending', 'importing', 'uploading', 'queued', 'processing', 'ready', 'failed'));
ALTER TABLE songs ADD COLUMN queued_at timestamptz;
CREATE INDEX songs_pending_idx ON songs (user_id, queued_at, id) WHERE status = 'pending';
