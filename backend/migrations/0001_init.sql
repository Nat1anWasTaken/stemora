CREATE TABLE users (
    id            uuid PRIMARY KEY,
    email         text NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
    token_hash bytea PRIMARY KEY,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    used_at    timestamptz
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE songs (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        text NOT NULL,
    filename     text NOT NULL,
    content_type text NOT NULL,
    size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
    status       text NOT NULL CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
    duration_s   double precision,
    model        text NOT NULL CHECK (model IN ('htdemucs', 'htdemucs_ft')),
    original_key text NOT NULL,
    upload_id    text,
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX songs_user_created_idx ON songs (user_id, created_at DESC);
CREATE INDEX songs_uploading_idx ON songs (created_at) WHERE status = 'uploading';

CREATE TABLE jobs (
    id                uuid PRIMARY KEY,
    song_id           uuid NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    model             text NOT NULL,
    attempt           integer NOT NULL DEFAULT 1,
    status            text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    progress          integer NOT NULL DEFAULT 0,
    stage             text,
    error             text,
    modal_call_id     text,
    last_heartbeat_at timestamptz,
    next_run_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz
);
CREATE INDEX jobs_song_idx ON jobs (song_id, created_at DESC);
CREATE INDEX jobs_due_idx ON jobs (next_run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (last_heartbeat_at) WHERE status = 'running';

CREATE TABLE stems (
    song_id   uuid NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    name      text NOT NULL CHECK (name IN ('vocals', 'drums', 'bass', 'other')),
    m4a_key   text NOT NULL,
    flac_key  text NOT NULL,
    m4a_size  bigint NOT NULL,
    flac_size bigint NOT NULL,
    PRIMARY KEY (song_id, name)
);
