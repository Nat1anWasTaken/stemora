# Stemora

Self-hostable, open-source stem separation and practice player (a Moises alternative).
Upload a song, a serverless GPU (Modal) runs Demucs, then practice along in a multitrack player:
per-stem volume, mute/solo, seek, A-B loop, downloads, and a personal library.

- `frontend/` React + TypeScript + Vite + Tailwind v4 + shadcn/ui (Base UI), mobile-first player
- `backend/` Rust (axum, sqlx, Postgres): users, invites, songs, jobs, presigned R2 uploads
- `worker/` Modal app running Demucs (`htdemucs` / `htdemucs_ft`) and posting progress webhooks
- `docs/contract.md` the interface between the three

## Run it
1. Create a private Cloudflare R2 bucket and an S3 API token; set bucket CORS (PUT/GET/HEAD from your origin, expose `ETag`).
2. Deploy the worker: see `worker/README.md` (`modal secret create stemora-r2 ...`, `stemora-auth`, `modal deploy app.py`).
3. `cp .env.example .env`, fill it in, then `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build` (or point your reverse proxy at the `frontend` service, port 80).
4. Open the site; the first visit creates the admin account. Admins create invite links for everyone else.

See `AGENTS.md` for contributor notes (including the `@shadcn/lint` rule).
