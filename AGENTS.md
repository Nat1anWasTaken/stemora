# Stemora: agent instructions

Self-hosted Moises alternative: upload a song, split it into stems (vocals/drums/bass/other), practise along in the browser.

## Layout
- `docs/contract.md`: the binding interface between worker, backend and frontend. Change it if you change an interface.
- `worker/`: Modal (Python) Demucs worker.
- `backend/`: Rust HTTP API, auth, jobs, R2 presigning.
- `frontend/`: React 19 + Vite + Tailwind v4 + shadcn/ui (Base UI) SPA, Web Audio multitrack player. See `frontend/README.md`.

## Frontend rules (required)
- After any change under `frontend/`, run `pnpm --dir frontend lint` and fix every error. Also run `pnpm --dir frontend typecheck`, `pnpm --dir frontend test` and `pnpm --dir frontend build` before finishing.
- Lint uses `@shadcn/lint` (no-restyle, no-raw-colors, no-arbitrary-values, no-inline-styles, no-unknown-classes, require-static-classes). Do not disable rules or add eslint-disable comments for them.
- Use semantic theme tokens (`bg-card`, `text-muted-foreground`, `bg-stem`, `text-vocals`, ...) defined in `frontend/src/index.css`. Never use palette colours or arbitrary values.
- Need a gradient, safe-area inset or other CSS that utilities cannot express? Add an `@utility` or token in `frontend/src/index.css` and use that class.
- Components in `src/components/ui` own their look: add a variant there rather than restyling from call sites.
- Develop without the backend: `pnpm --dir frontend dev:mock` (login `dev@stemora.test` / `password`).
