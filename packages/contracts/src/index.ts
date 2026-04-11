import { z } from "zod";

export const memberRoleSchema = z.enum(["owner", "controller", "listener"]);
export const transportStatusSchema = z.enum(["idle", "playing", "paused"]);
export const assetKindSchema = z.enum(["original", "normalized_playback", "streaming_playback", "artwork"]);
export const mediaJobStatusSchema = z.enum(["pending", "processing", "complete", "failed"]);

export const createSessionSchema = z.object({
  sessionName: z.string().trim().min(1).max(80).default("Shared Listening Room"),
  displayName: z.string().trim().min(1).max(40)
});

export const joinSessionSchema = z.object({
  displayName: z.string().trim().min(1).max(40),
  accessCode: z.string().trim().min(4).max(32)
});

export const queueMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    trackId: z.string().uuid()
  }),
  z.object({
    type: z.literal("remove"),
    queueItemId: z.string().uuid()
  }),
  z.object({
    type: z.literal("move"),
    queueItemId: z.string().uuid(),
    toIndex: z.number().int().min(0)
  }),
  z.object({
    type: z.literal("select"),
    queueItemId: z.string().uuid()
  })
]);

export const playbackControlSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("play"),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("stop"),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("pause"),
    revision: z.number().int().nonnegative(),
    positionMs: z.number().nonnegative().optional()
  }),
  z.object({
    action: z.literal("seek"),
    revision: z.number().int().nonnegative(),
    positionMs: z.number().nonnegative()
  }),
  z.object({
    action: z.literal("next"),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    action: z.literal("previous"),
    revision: z.number().int().nonnegative()
  })
]);

export const updateMemberRoleSchema = z.object({
  role: memberRoleSchema
});

export const clientCapabilitiesSchema = z.object({
  mimeTypes: z.array(z.string()).default([]),
  supportsFlac: z.boolean().default(false),
  supportsMp3: z.boolean().default(true),
  supportsWav: z.boolean().default(true),
  supportsAiff: z.boolean().default(false),
  supportsMseFlacSegmented: z.boolean().default(false)
});

export const memberSchema = z.object({
  memberId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  role: memberRoleSchema,
  joinedAt: z.string(),
  isActive: z.boolean()
});

export const assetSchema = z.object({
  assetId: z.string().uuid(),
  kind: assetKindSchema,
  mimeType: z.string(),
  codec: z.string().nullable(),
  container: z.string().nullable(),
  sampleRate: z.number().nullable(),
  bitDepth: z.number().nullable(),
  channels: z.number().nullable(),
  status: mediaJobStatusSchema.optional()
});

export const playbackDescriptorSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("lossless_chunked"),
    assetId: z.string().uuid(),
    status: mediaJobStatusSchema.optional(),
    chunkMimeType: z.string(),
    manifestUrl: z.string()
  }),
  z.object({
    mode: z.literal("mse_segmented"),
    assetId: z.string().uuid(),
    status: mediaJobStatusSchema.optional(),
    mediaSourceMimeType: z.string(),
    manifestUrl: z.string()
  }),
  z.object({
    mode: z.literal("direct_file"),
    assetId: z.string().uuid(),
    status: mediaJobStatusSchema.optional(),
    mimeType: z.string(),
    streamUrl: z.string()
  })
]);

export const trackSchema = z.object({
  trackId: z.string().uuid(),
  originalFilename: z.string(),
  displayTitle: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  mimeType: z.string().nullable(),
  codec: z.string().nullable(),
  sampleRate: z.number().nullable(),
  bitDepth: z.number().nullable(),
  channels: z.number().nullable(),
  playbackReady: z.boolean(),
  pendingJobStatus: mediaJobStatusSchema.nullable(),
  pendingJobProgress: z.number().min(0).max(100).nullable(),
  assets: z.array(assetSchema)
});

export const queueItemSchema = z.object({
  queueItemId: z.string().uuid(),
  sessionId: z.string().uuid(),
  trackId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  isSelected: z.boolean(),
  track: trackSchema
});

export const transportStateSchema = z.object({
  sessionId: z.string().uuid(),
  trackId: z.string().uuid().nullable(),
  status: transportStatusSchema,
  basePositionMs: z.number().nonnegative(),
  effectiveAtMs: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  updatedByMemberId: z.string().uuid().nullable()
});

export const sessionStateSchema = z.object({
  sessionId: z.string().uuid(),
  sessionName: z.string(),
  listenerCode: z.string().nullable(),
  controllerCode: z.string().nullable(),
  currentMember: memberSchema,
  members: z.array(memberSchema),
  queue: z.array(queueItemSchema),
  transport: transportStateSchema,
  serverTimeMs: z.number().int().nonnegative()
});

export const uploadStatusEventSchema = z.object({
  sessionId: z.string().uuid(),
  trackId: z.string().uuid(),
  jobStatus: mediaJobStatusSchema,
  message: z.string()
});

export const transportCommandEventSchema = z.object({
  sessionId: z.string().uuid(),
  trackId: z.string().uuid().nullable(),
  status: transportStatusSchema,
  positionMs: z.number().nonnegative(),
  revision: z.number().int().nonnegative(),
  serverTimeMs: z.number().int().nonnegative(),
  effectiveAtMs: z.number().int().nonnegative(),
  issuedByMemberId: z.string().uuid().nullable()
});

export const playbackManifestSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  url: z.string()
});

export const playbackManifestSchema = z.object({
  version: z.literal(1),
  trackId: z.string().uuid(),
  assetId: z.string().uuid(),
  mode: z.enum(["mse_segmented", "lossless_chunked"]),
  durationMs: z.number().int().nonnegative(),
  segmentDurationMs: z.number().int().positive(),
  initSegmentUrl: z.string().optional(),
  mediaSourceMimeType: z.string().optional(),
  chunkMimeType: z.string().optional(),
  segments: z.array(playbackManifestSegmentSchema)
});

export const supportedUploadExtensions = [
  ".mp3",
  ".flac",
  ".wav",
  ".aiff",
  ".aif",
  ".m4a",
  ".alac",
  ".dsf",
  ".dff",
  ".ape",
  ".wv"
] as const;

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type JoinSessionInput = z.infer<typeof joinSessionSchema>;
export type QueueMutationInput = z.infer<typeof queueMutationSchema>;
export type PlaybackControlInput = z.infer<typeof playbackControlSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type QueueItem = z.infer<typeof queueItemSchema>;
export type TransportCommandEvent = z.infer<typeof transportCommandEventSchema>;
export type PlaybackDescriptor = z.infer<typeof playbackDescriptorSchema>;
export type PlaybackManifest = z.infer<typeof playbackManifestSchema>;
