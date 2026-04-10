create table if not exists users (
  id uuid primary key,
  display_name text not null,
  provider text not null default 'session_code',
  provider_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists sessions (
  id uuid primary key,
  name text not null,
  listener_code text not null,
  controller_code text not null,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
--> statement-breakpoint
create table if not exists session_members (
  id uuid primary key,
  session_id uuid not null,
  user_id uuid not null,
  role text not null,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists access_tokens (
  id uuid primary key,
  session_id uuid not null,
  member_id uuid not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists tracks (
  id uuid primary key,
  session_id uuid not null,
  uploaded_by_member_id uuid not null,
  original_filename text not null,
  display_title text not null,
  artist text,
  album text,
  duration_ms integer,
  mime_type text,
  codec text,
  sample_rate integer,
  bit_depth integer,
  channels integer,
  file_hash text,
  created_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists track_assets (
  id uuid primary key,
  track_id uuid not null,
  kind text not null,
  status text not null default 'complete',
  storage_path text not null,
  mime_type text not null,
  container text,
  codec text,
  sample_rate integer,
  bit_depth integer,
  channels integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  error_message text
);
--> statement-breakpoint
create table if not exists queue_items (
  id uuid primary key,
  session_id uuid not null,
  track_id uuid not null,
  position integer not null,
  is_selected boolean not null default false,
  created_at timestamptz not null default now(),
  added_by_member_id uuid not null
);
--> statement-breakpoint
create table if not exists playback_state (
  session_id uuid primary key,
  track_id uuid,
  status text not null default 'idle',
  base_position_ms integer not null default 0,
  effective_at_ms bigint not null default 0,
  revision integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by_member_id uuid
);
--> statement-breakpoint
create table if not exists media_jobs (
  id uuid primary key,
  session_id uuid not null,
  track_id uuid not null,
  asset_id uuid,
  job_type text not null,
  status text not null default 'pending',
  payload jsonb not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create table if not exists audit_events (
  id uuid primary key,
  session_id uuid not null,
  member_id uuid,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
