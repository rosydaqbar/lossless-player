# Lossless Shared Listening Player

Greenfield `pnpm` workspace for a synchronized, browser-based lossless listening room.

## Workspace

- `apps/web`: React + Vite + JavaScript/JSX + Radix UI + Tailwind CSS
- `apps/api`: Fastify + Socket.IO + Drizzle + PostgreSQL integration
- `packages/contracts`: shared Zod schemas and transport contracts

## Local setup

1. Copy `.env.example` to `.env`.
2. Install dependencies with `corepack pnpm install`.
3. Run DB migrations with `corepack pnpm db:migrate`.
4. Start the apps with `corepack pnpm dev`.

By default the repo now uses embedded PGlite for local development, so Docker/PostgreSQL are optional rather than required.

If you want full PostgreSQL locally instead, set `DATABASE_DRIVER=postgres` and point `DATABASE_URL` at your database. The included `docker-compose.yml` still works for that path.

## Notes

- Local development defaults to PGlite, which keeps the schema Postgres-compatible while avoiding a separate database install.
- FFmpeg paths are resolved from bundled static binaries in the API package, so you do not need global `ffmpeg` or `ffprobe` for the default setup.
- Package apps read the repo-root `.env`, so keep configuration there.
- If `ENABLE_MEDIA_JOBS=false`, uploads still work for direct-play formats, but unsupported formats will not auto-normalize.
- Shared playback is server-authoritative through REST mutations plus Socket.IO room broadcasts.
