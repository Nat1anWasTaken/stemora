-- Playback settings sets (see docs/playback.md): one per song, one "listening" set per user. NULL = never saved.
ALTER TABLE songs ADD COLUMN settings jsonb;
ALTER TABLE users ADD COLUMN listening_settings jsonb;
