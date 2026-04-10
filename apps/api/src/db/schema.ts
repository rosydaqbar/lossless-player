import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  displayName: text("display_name").notNull(),
  provider: text("provider").notNull().default("session_code"),
  providerUserId: text("provider_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  listenerCode: text("listener_code").notNull(),
  controllerCode: text("controller_code").notNull(),
  createdByUserId: uuid("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
});

export const sessionMembers = pgTable("session_members", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  memberId: uuid("member_id").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
});

export const tracks = pgTable("tracks", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  uploadedByMemberId: uuid("uploaded_by_member_id").notNull(),
  originalFilename: text("original_filename").notNull(),
  displayTitle: text("display_title").notNull(),
  artist: text("artist"),
  album: text("album"),
  durationMs: integer("duration_ms"),
  mimeType: text("mime_type"),
  codec: text("codec"),
  sampleRate: integer("sample_rate"),
  bitDepth: integer("bit_depth"),
  channels: integer("channels"),
  fileHash: text("file_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const trackAssets = pgTable("track_assets", {
  id: uuid("id").primaryKey(),
  trackId: uuid("track_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("complete"),
  storagePath: text("storage_path").notNull(),
  mimeType: text("mime_type").notNull(),
  container: text("container"),
  codec: text("codec"),
  sampleRate: integer("sample_rate"),
  bitDepth: integer("bit_depth"),
  channels: integer("channels"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  errorMessage: text("error_message")
});

export const queueItems = pgTable("queue_items", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  trackId: uuid("track_id").notNull(),
  position: integer("position").notNull(),
  isSelected: boolean("is_selected").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  addedByMemberId: uuid("added_by_member_id").notNull()
});

export const playbackState = pgTable("playback_state", {
  sessionId: uuid("session_id").primaryKey(),
  trackId: uuid("track_id"),
  status: text("status").notNull().default("idle"),
  basePositionMs: integer("base_position_ms").notNull().default(0),
  effectiveAtMs: bigint("effective_at_ms", { mode: "number" }).notNull().default(0),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByMemberId: uuid("updated_by_member_id")
});

export const mediaJobs = pgTable("media_jobs", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  trackId: uuid("track_id").notNull(),
  assetId: uuid("asset_id"),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("pending"),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  memberId: uuid("member_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
