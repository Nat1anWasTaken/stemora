# Stemora worker (Modal)

Stem separation on Modal with Demucs (`htdemucs`) or SCNet (`scnet_xl_ihf`, the "High quality" option). Interface: `../docs/contract.md`.

- `app.py` Modal app `stemora`: image, GPU function `separate`, `spawn` web endpoint, `local_test` entrypoint
- `runner.py` job orchestration; `pipeline.py` probe/decode/separate/encode/peaks/upload; `scnet/` vendored SCNet network + checkpoint registry (MIT, from ZFTurbo/Music-Source-Separation-Training); `webhook.py` payloads, retries, heartbeat; `schema.py` request validation

## Setup
```sh
uv sync                      # local dev env (modal, pytest, numpy)
uv run pytest                # unit tests, no GPU/Modal needed
```

## Secrets
```sh
uv run modal secret create stemora-r2 \
  R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
  R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=stemora --force
uv run modal secret create stemora-auth MODAL_SHARED_SECRET=$(openssl rand -hex 32) --force
```
The deployed `stemora-r2` currently holds PLACEHOLDER values; replace it before real use.
The generated shared secret lives in `.secrets.local` (gitignored) and goes in the backend as `MODAL_SHARED_SECRET`.

## Deploy
```sh
uv run modal deploy app.py                  # GPU (L4, falling back to A10G then T4); needs a payment method on the Modal workspace
STEMORA_GPU=none uv run modal deploy app.py # interim CPU-only deploy (8 cores, slower)
```
Prints the `spawn` URL (set as `MODAL_ENDPOINT_URL` in the backend) and the `cancel` URL (the backend derives it from the `spawn` URL). Redeploy after changing any secret value is not needed; secrets are read at container start.

## CI deploy
`.github/workflows/worker.yml` runs the tests on PRs and runs `modal deploy app.py` on pushes to `main` that touch `worker/` (also manually via "Run workflow"). Setup once:
1. Create a Modal token (`modal token new` or Settings -> API Tokens) for the workspace that holds `stemora-r2` / `stemora-auth`.
2. In the GitHub repo create an environment named `modal-production` (add required reviewers if you want a manual approval gate) and add the secrets `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` to it.
The deploy keeps the same `spawn` URL, so `MODAL_ENDPOINT_URL` in Dokploy does not change. The GPU list is `L4,A10G,T4` (comma-separated, in order of preference) unless `STEMORA_GPU` is set in the workflow env.

## Test
```sh
uv run modal run app.py::local_test --song-path ./sample.mp3 [--model scnet_xl_ihf] [--out-dir ./out]
```
Runs separate+encode+peaks on a file without R2/webhook, prints timings, writes stems locally.

Endpoint smoke test:
```sh
curl -X POST $URL -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' -d '{...contract body...}'
```
(401 bad secret, 422 invalid body, 200 `{"call_id":...}`.)

## Notes
- Progress 5..90 while separating (from Demucs' chunk loop, or per SCNet batch of 4 x 11 s chunks); heartbeat webhook every 15s from start to finish.
- Stops early when the backend says the job is gone (410) or superseded (`cancel: true`); on 410 it also deletes the objects it already uploaded.
- peaks.json: each stem normalised so its loudest bucket = 1.0 (silent stem = all 0).
- Stems are scaled by one common gain only if any would clip (ceiling 0.99); FLAC is 24-bit.
- Weights are baked into the image (Demucs in `TORCH_HOME=/opt/torch`, SCNet in `/opt/scnet`, sha256-checked at build).
- 4 min song on an L4, separation only: htdemucs 14 s, scnet_xl_ihf 43 s; encoding adds ~27 s to each. (The retired htdemucs_ft took 33 s.)
