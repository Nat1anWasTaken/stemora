# Stemora frontend

React 19, TypeScript (strict), Vite, Tailwind CSS v4, shadcn/ui on Base UI, React Router, TanStack Query, zustand, sonner. Dark theme only.

## Commands (pnpm)
| Command | What |
| --- | --- |
| `pnpm dev` | Dev server; `/api` proxied to `http://localhost:8080` |
| `pnpm dev:mock` | Dev server with an in-memory mock of the contract (`mock/plugin.ts`), no backend needed |
| `pnpm lint` | ESLint with `@shadcn/lint` design rules |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (mixer/loop/peaks logic, upload chunking and retry, formatters) |
| `pnpm build` | Type-check and production build to `dist/` |
| `pnpm mock:audio` | Regenerate the 4 mock stems + peaks in `public/mock` (needs ffmpeg) |

## Mock mode
`pnpm dev:mock` serves the whole API from memory: seeded login `dev@stemora.test` / `password` (admin), one ready song with four 20 s generated stems, one processing, one failed. Uploads hit fake presigned `PUT /mock-upload/...` URLs and then run a ~16 s simulated job. `VITE_MOCK_FRESH=1` starts with zero users to try first-run bootstrap; invite token `invalid` shows the invalid-invite page. Link imports walk through the backend's stages (waiting, probing, a ~6 s simulated download, storing) before the job starts; links containing `broken` fail the preview, `long` preview as too long, and `fail` fail mid-import.

## Structure
- `src/player/engine.ts`: framework-free Web Audio engine. All stems start at one shared `ctx.currentTime` and offset (sample-accurate sync); seeking recreates sources; A-B loops use the sources' own `loopStart`/`loopEnd`; metronome click scheduler with optional one-bar count-in. Pure logic (mixer/solo/loop maths, peaks) lives in `mixer.ts` / `peaks.ts` and is unit-tested.
- `src/player/store.ts`: zustand store driving the engine; `ui/` holds the player components, `mediaSession.ts` and `keepAlive.ts` handle lock-screen controls and background playback (best effort, a silent looping `<audio>` keeps iOS/Android treating the page as media).
- `src/lib/upload.ts`: single PUT or 16 MiB multipart upload with per-part retry, ETag collection, then `POST /complete`.
- `src/components/ui`: shadcn components (Base UI style `base-nova`).
- Theme tokens, gradients and safe-area utilities: `src/index.css`.

## Shortcuts (desktop player)
Space play/pause, Left/Right skip 10 s (Shift: 30 s), 1-4 pick a stem, M mute it, S solo it, L cycle loop (set A, set B, clear), Home restart.

## Deployment
`Dockerfile` builds the SPA and serves it with nginx (`nginx.conf`): history fallback, gzip, long cache for `/assets`, no-cache for `sw.js`, and `location /api/` proxied to `http://backend:8080` (1 MB body limit; files go directly to R2). The R2 bucket CORS must allow `PUT` from the site origin and **expose the `ETag` header**, otherwise multipart uploads cannot complete.

## Notes
- iOS: audio starts from the first Play tap (AudioContext resume).
- PWA: `vite-plugin-pwa` (generateSW) precaches the app shell, so the installed app opens offline and shows a "Can't reach Stemora" screen instead of bouncing to login. `/api` and the presigned stem URLs are never cached, so songs still need a connection. `public/manifest.webmanifest` stays the manifest source. A new deploy shows a Reload toast (`src/components/app/pwa.tsx`, also checks hourly); the Account page offers Install (Chromium prompt, or Safari's Add to Home Screen hint). The service worker only runs in `pnpm build`/`pnpm preview`, not in `pnpm dev`.
- Peaks come from `peaks_url`; if missing they are computed from the decoded audio.
