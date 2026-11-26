-- Setlists (see docs/playback.md): saved, ordered lists of a user's songs, for listening or the stage.
CREATE TABLE setlists (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            text NOT NULL,
    -- Which settings set the player starts on when the setlist is played.
    settings_source text NOT NULL DEFAULT 'setlist' CHECK (settings_source IN ('song', 'setlist', 'listening')),
    -- What happens when a song ends: play the next one, or load it and wait.
    transition      text NOT NULL DEFAULT 'stop' CHECK (transition IN ('continue', 'stop')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX setlists_user_idx ON setlists (user_id, updated_at DESC);

CREATE TABLE setlist_entries (
    id          uuid PRIMARY KEY,
    setlist_id  uuid NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
    position    integer NOT NULL,
    song_id     uuid NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    -- The song's settings as they were when it was added (a copy), then edited for this setlist. NULL = none yet.
    settings    jsonb,
    -- Overrides the setlist's transition after this entry; NULL = the setlist's.
    transition  text CHECK (transition IN ('continue', 'stop')),
    notes       text NOT NULL DEFAULT ''
);
CREATE INDEX setlist_entries_setlist_idx ON setlist_entries (setlist_id, position);
CREATE INDEX setlist_entries_song_idx ON setlist_entries (song_id);
