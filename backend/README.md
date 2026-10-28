# Stemora backend

Rust (axum 0.8, sqlx/Postgres) API for Stemora. It handles auth, invites, presigned uploads to
Cloudflare R2, job dispatch to the Modal worker, the worker webhook, and a background reaper.
The interface is defined in [`../docs/contract.md`](../docs/contract.md).

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres URL. Migrations run on startup. |
| `PUBLIC_BASE_URL` | required | Public origin, e.g. `https://stemora.example.com`. Used for invite URLs, webhook callback URLs and the cookie `Secure` flag. |
| `BIND_ADDR` | `0.0.0.0:8080` | |
| `R2_ENDPOINT` | required | `https://<account>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | required | R2 API token with object read/write on the bucket |
| `R2_BUCKET` | required | Private bucket (path-style addressing is used) |
| `R2_REGION` | `auto` | |
| `MODAL_ENDPOINT_URL` | empty | Modal `spawn` endpoint. Empty: uploads work, jobs fail with a clear error. |
| `MODAL_SHARED_SECRET` | empty | Bearer secret for the Modal endpoint |
| `WEBHOOK_SIGNING_KEY` | required (>=16 chars) | Per-job callback token = hex HMAC-SHA256(key, `{job_id}:{attempt}`) |
| `MAX_UPLOAD_MB` | `200` | Per-file cap (MiB), also enforced after upload via HEAD |
| `MAX_DURATION_S` | `900` | Passed to the worker |
| `USER_QUOTA_MB` | `5000` | Per-user: sum of original sizes + stem sizes |
| `MAX_CONCURRENT_JOBS` | `2` | Queued+running jobs per user (429 beyond) |
| `COOKIE_SECURE` | auto | Overrides the Secure flag (default: on iff `PUBLIC_BASE_URL` is https) |
| `LOG_FORMAT` / `RUST_LOG` | text / `info` | `LOG_FORMAT=json` for structured logs |

See `.env.example`.

## Run locally

```sh
docker run -d --name stemora-pg -e POSTGRES_PASSWORD=stemora -e POSTGRES_USER=stemora \
  -e POSTGRES_DB=stemora -p 127.0.0.1:5432:5432 postgres:17
cp .env.example .env      # fill in R2 + WEBHOOK_SIGNING_KEY
set -a; . ./.env; set +a
cargo run
```

On a fresh database `GET /api/auth/status` returns `{"needs_bootstrap": true}`; `POST /api/auth/bootstrap`
creates the first (admin) user. After that the admin creates invite links via `POST /api/admin/invites`.

Modal needs to reach the backend webhook, so for real jobs `PUBLIC_BASE_URL` must be a public URL
(tunnel in development).

## Tests

```sh
docker run -d --name stemora-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:56432:5432 postgres:17
cargo test            # TEST_DATABASE_URL overrides postgres://postgres:postgres@localhost:56432/postgres
cargo clippy --all-targets -- -D warnings
```

Unit tests need nothing. Integration tests (`tests/api.rs`) create a throwaway database per test on that
Postgres and use in-memory fakes for R2 and Modal; **they are skipped with a warning if Postgres is
unreachable**.

## R2 bucket CORS

Browsers upload and play directly against R2 with presigned URLs, so the bucket needs CORS for the app origin
(R2 dashboard > bucket > Settings > CORS policy):

```json
[
  {
    "AllowedOrigins": ["https://stemora.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ETag` must be exposed: the multipart upload needs each part's ETag to complete the upload.
Add `http://localhost:5173` (or your dev origin) to `AllowedOrigins` for local development.

## Notes

- **Upload size enforcement.** Presigned PUT URLs (and R2) cannot enforce `content-length-range`; the declared size is
  checked against `MAX_UPLOAD_MB` at creation and the real object size is verified with HEAD in
  `POST /api/songs/{id}/complete` (mismatched or oversize objects are deleted and the song fails). The presigned
  PUT binds `Content-Type`, so the client must send exactly the `headers` returned by `POST /api/songs`.
- **Retries.** A job keeps one id across attempts; the attempt number is part of the callback token, so updates from
  superseded attempts are acknowledged and ignored. Backoff: 30s after attempt 1, 120s after attempt 2; max 3 attempts.
- **Reaper** (every 15s): re-spawns due retries, fails jobs with no heartbeat for 5 min, purges `uploading` songs older than 24h.
- Rate limiting is in-memory and per process (30 upload actions per user per 10 minutes; 10 logins per email per 10 minutes).
  Run a single backend replica.
- Healthcheck: `GET /api/healthz`; the container uses `stemora-backend healthcheck`.

## Docker

```sh
docker build -t stemora-backend .
docker run --env-file .env -p 8080:8080 stemora-backend
```
