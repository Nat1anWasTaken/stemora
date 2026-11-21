-- Drum-notation line breaks by time (the start of the bar that begins a row, in seconds), so they stay with the
-- music when the tempo map changes the bars. `drum_breaks` (bar indices) is only read to convert older songs; saving
-- times clears it.
ALTER TABLE songs ADD COLUMN drum_break_times double precision[] NOT NULL DEFAULT '{}';
