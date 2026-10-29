-- Library sorting by title (GET /api/songs?sort=title); keyset pagination tiebreaks on id.
CREATE INDEX songs_user_title_idx ON songs (user_id, lower(title), id);
