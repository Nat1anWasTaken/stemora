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
`pnpm dev:mock` serves the whole API from memory: seeded login `dev@stemora.test` / `password` (admin), one ready song with four 20 s generated stems, one processing, one failed. Uploads hit fake presigned `PUT /mock-upload/...` URLs and then run a ~16 s simulated job. `VITE_MOCK_FRESH=1` starts with zero users to try first-run bootstrap; invite token `invalid` shows the invalid-invite page.

## Structure
- `src/player/engine.ts`: framework-free Web Audio engine. All stems start at one shared `ctx.currentTime` and offset (sample-accurate sync); seeking recreates sources; A-B loops use the sources' own `loopStart`/`loopEnd`; metronome click scheduler with optional one-bar count-in. Pure logic (mixer/solo/loop maths, peaks) lives in `mixer.ts` / `peaks.ts` and is unit-tested.
- `src/player/store.ts`: zustand store driving the engine; `ui/` holds the player components, `mediaSession.ts` and `keepAlive.ts` handle lock-screen controls and background playback (best effort, a silent looping `<audio>` keeps iOS/Android treating the page as media).
- `src/lib/upload.ts`: single PUT or 16 MiB multipart upload with per-part retry, ETag collection, then `POST /complete`.
- `src/components/ui`: shadcn components (Base UI style `base-nova`).
- Theme tokens, gradients, safe-area utilities and motion (`ease-spring`, `animate-page`, `stagger-children`, `animate-sheet-in/out`, `pressable`, `sheet-drag`): `src/index.css`. Everything respects `prefers-reduced-motion`.

## Mobile player
Two tabs that fit the screen without scrolling the page: **Mixer** (four stem rows with mute, volume, solo and a menu, plus an "All stems" reset) and **Practice** (metronome, 15 s loop sections, waveform). The full preset-chip row is shown only on desktop. Swipe the grab bar or header down to close the player (`use-sheet-drag.ts`).

## Shortcuts (desktop player)
Space play/pause, Left/Right skip 10 s (Shift: 30 s), 1-4 pick a stem, M mute it, S solo it, L cycle loop (set A, set B, clear), Home restart.

## Deployment
`Dockerfile` builds the SPA and serves it with nginx (`nginx.conf`): history fallback, gzip, long cache for `/assets`, and `location /api/` proxied to `http://backend:8080` (1 MB body limit; files go directly to R2). The R2 bucket CORS must allow `PUT` from the site origin and **expose the `ETag` header**, otherwise multipart uploads cannot complete.

## Notes
- iOS: audio starts from the first Play tap (AudioContext resume). The player is an installable PWA (manifest + icons); there is no offline mode.
- Peaks come from `peaks_url`; if missing they are computed from the decoded audio.
