-- User-placed line breaks in the drum notation: indices of the bars that start a new row (sorted, unique).
ALTER TABLE songs ADD COLUMN drum_breaks integer[] NOT NULL DEFAULT '{}';
