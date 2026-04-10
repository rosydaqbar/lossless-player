# Supabase Migration Checklist

The current implementation is Postgres-first and local-disk-first to keep the application logic portable.

## Planned swaps

- `DATABASE_URL` -> Supabase Postgres connection string
- `LocalStorageProvider` -> Supabase Storage-backed provider
- Session-code auth -> Supabase Auth or Discord-backed identity provider

## Keep stable

- Drizzle schema and repository APIs
- REST contract and Socket.IO event payloads
- Playback authority and sync algorithms

## Migration steps

1. Provision Supabase project and copy connection string.
2. Apply Drizzle migrations to Supabase Postgres.
3. Replace the storage adapter and move existing assets.
4. Add auth adapter for provider-backed identities.
5. Optionally add presence and history via Supabase Realtime, while keeping transport control in the app server.
