# Stemora interface contract

Shared by `/worker` (Modal, Python), `/backend` (Rust) and `/frontend` (React). Follow this exactly; if something must change, change this file too and say so in your report.

## R2 object keys (bucket is private)
```
users/{user_id}/songs/{song_id}/original.{ext}
users/{user_id}/songs/{song_id}/stems/{name}.m4a     # AAC 192k stereo 44.1kHz, playback (universal decodeAudioData support, Safari included)
users/{user_id}/songs/{song_id}/stems/{name}.flac    # lossless, download
users/{user_id}/songs/{song_id}/peaks.json           # {"version":1,"samples_per_second":20,"stems":{"vocals":[0..1 floats,...],...}} (normalised 0..1 max-abs per bucket)
```
Stem names are exactly: `vocals`, `drums`, `bass`, `other`. UUIDs are lowercase hyphenated.
WAV is not produced (FLAC is the lossless download).

## Modal worker API
Modal app `stemora`, a web endpoint (`@modal.fastapi_endpoint(method="POST")`) named `spawn`.
Request: `POST {MODAL_ENDPOINT_URL}` with `Authorization: Bearer {MODAL_SHARED_SECRET}` and JSON:
```json
{"job_id":"uuid","attempt":1,"user_id":"uuid","song_id":"uuid","original_key":"users/.../original.mp3",
 "model":"htdemucs"|"htdemucs_ft","callback_url":"https://host/api/webhooks/jobs/{job_id}",
 "callback_token":"hex","max_duration_s":900}
```
Response (immediately, 200): `{"call_id":"fc-..."}`. 401 on bad secret. The endpoint does `fn.spawn(...)` for the GPU function and returns.
Modal secrets: `stemora-r2` (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`), `stemora-auth` (`MODAL_SHARED_SECRET`).
GPU function: `retries=0`, scale-to-zero (no min_containers), timeout 20 min, weights for both models baked into the image.

## Webhook (worker -> backend)
`POST {callback_url}` with `Authorization: Bearer {callback_token}`, JSON:
```json
{"status":"running"|"done"|"failed","stage":"downloading|validating|separating|encoding|uploading|done",
 "progress":0-100,
 "error":"human readable (failed only)","retryable":true|false,
 "duration_s":123.4,
 "stems":[{"name":"vocals","m4a_key":"...","flac_key":"...","m4a_size":123,"flac_size":456}],
 "peaks_key":"..."}
```
`duration_s`, `stems`, `peaks_key` only on `done`. `error`/`retryable` only on `failed`. Worker retries each webhook POST up to 3 times with backoff. Running updates double as heartbeats (send at least every ~20s while separating). Validation failures (not audio, too long, no audio stream) are `retryable:false`; infra/transient failures are `retryable:true`.
`callback_token` = hex(HMAC-SHA256(WEBHOOK_SIGNING_KEY, "{job_id}:{attempt}")). The backend recomputes and compares in constant time; the worker never sees the signing key.

## Backend HTTP API (all JSON under `/api`, session cookie `stemora_session`, HttpOnly, SameSite=Lax, Secure when `PUBLIC_BASE_URL` is https)
Errors: `{"error":"message","code":"snake_case"}` with proper HTTP status.

Types:
```ts
type User = { id: string; email: string; role: "admin" | "user" }
type SongStatus = "uploading" | "queued" | "processing" | "ready" | "failed"
type Song = { id: string; title: string; status: SongStatus; duration_s: number | null; size_bytes: number;
              model: "htdemucs" | "htdemucs_ft"; progress: number; stage: string | null; error: string | null;
              created_at: string }
type Stem = { name: "vocals"|"drums"|"bass"|"other"; url: string /* presigned GET m4a */; size_bytes: number }
type SongDetail = { song: Song; stems: Stem[]; peaks_url: string | null }
type Usage = { used_bytes: number; quota_bytes: number }
```
Auth:
- `GET /api/auth/status` -> `{needs_bootstrap: boolean}` (public)
- `POST /api/auth/bootstrap` `{email,password}` -> User (only while zero users exist, else 403; creates admin + session)
- `POST /api/auth/login` `{email,password}` -> User; `POST /api/auth/logout` -> 204; `GET /api/auth/me` -> User | 401
- `GET /api/invites/{token}` -> `{valid:boolean}` (public); `POST /api/auth/accept-invite` `{token,email,password}` -> User
- `POST /api/admin/invites` (admin) -> `{token, url, expires_at}` (url = PUBLIC_BASE_URL + "/invite/" + token); `GET /api/admin/invites` (admin) -> list
Songs (auth required, scoped to the session user; other users' ids return 404):
- `GET /api/songs` -> Song[] (newest first)
- `POST /api/songs` `{title, filename, content_type, size, model}` -> `{song: Song, upload: Upload}`
  where `Upload = {mode:"single", url:string, headers:Record<string,string>} | {mode:"multipart", upload_id:string, part_size:number, part_count:number}`.
  Single PUT when size <= 50 MiB, else multipart with 16 MiB parts. Rejects: size > MAX_UPLOAD_MB (413), non-audio content type/extension (415), quota exceeded (403 `quota_exceeded`), rate limit (429).
- `POST /api/songs/{id}/upload/parts` `{part_numbers:number[]}` -> `{urls:{part_number:number,url:string}[]}` (multipart only)
- `POST /api/songs/{id}/complete` `{parts?:{part_number:number,etag:string}[]}` -> Song. Completes multipart if needed, HEADs the object (size must match and be within cap), creates the job, spawns Modal. Idempotent. Concurrent-active-job limit per user -> 429.
- `GET /api/songs/{id}` -> SongDetail (stems/peaks_url only when ready; presigned URLs valid 1h)
- `PATCH /api/songs/{id}` `{title}` -> Song; `DELETE /api/songs/{id}` -> 204 (removes R2 prefix `users/{uid}/songs/{sid}/`, DB rows)
- `POST /api/songs/{id}/reprocess` `{model}` -> Song (needs original still present; deletes old stems)
- `GET /api/songs/{id}/stems/{name}/download?format=m4a|flac` -> 302 to presigned GET with `Content-Disposition: attachment; filename="{title} - {name}.{ext}"`
- `GET /api/me/usage` -> Usage
Webhook: `POST /api/webhooks/jobs/{job_id}` (token auth as above, not cookie). Idempotent; ignores updates for jobs already in a terminal state or for a stale attempt.

Job/song state machine: song `uploading` -> (complete) `queued` -> (first `running` webhook) `processing` -> `ready` | `failed`. Retryable failure with attempts < 3 re-spawns after backoff (30s, 120s) and stays `processing`/`queued`; reaper fails jobs without a heartbeat for 5 minutes (retry if attempts left) and deletes `uploading` songs older than 24h (abort multipart, remove objects).

Env (backend): `DATABASE_URL`, `PUBLIC_BASE_URL`, `BIND_ADDR` (default 0.0.0.0:8080), `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REGION` (default `auto`), `MODAL_ENDPOINT_URL`, `MODAL_SHARED_SECRET`, `WEBHOOK_SIGNING_KEY`, `MAX_UPLOAD_MB` (default 200), `MAX_DURATION_S` (default 900), `USER_QUOTA_MB` (default 5000), `MAX_CONCURRENT_JOBS` (default 2), `COOKIE_SECURE` (optional override).
