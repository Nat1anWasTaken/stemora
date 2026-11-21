-- The song's tempo map (see docs/contract.md): sorted markers, the first at 0. Every song starts with one auto marker.
ALTER TABLE songs ADD COLUMN tempo_markers jsonb NOT NULL DEFAULT '[{"time":0.0,"kind":"auto"}]';
