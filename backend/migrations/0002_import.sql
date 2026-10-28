-- Songs imported from a link (yt-dlp on the backend) start in 'importing'.
ALTER TABLE songs ADD COLUMN source_url text;
ALTER TABLE songs DROP CONSTRAINT songs_status_check;
ALTER TABLE songs ADD CONSTRAINT songs_status_check
    CHECK (status IN ('importing', 'uploading', 'queued', 'processing', 'ready', 'failed'));
