import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  clientCapabilitiesSchema,
  createSessionSchema,
  joinSessionSchema,
  playbackControlSchema,
  queueMutationSchema,
  updateMemberRoleSchema
} from "@lossless-player/contracts";
import { requiresSegmentedLosslessPlayback } from "./lib/playback.js";
import { AuthService } from "./services/auth-service.js";
import { AdminService } from "./services/admin-service.js";
import { MediaService } from "./services/media-service.js";
import { PlaybackAuthority } from "./services/playback-authority.js";
import { RealtimeHub } from "./services/realtime-hub.js";
import { SessionService } from "./services/session-service.js";

function extractToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7);
  }
  const queryToken = (request.query as Record<string, string | undefined>)?.accessToken;
  return queryToken ?? null;
}

async function requireAccess(request: FastifyRequest, authService: AuthService, sessionId: string) {
  const token = extractToken(request);
  if (!token) {
    const error = new Error("Missing access token");
    // @ts-expect-error custom status code
    error.statusCode = 401;
    throw error;
  }
  return authService.getSessionAccess(sessionId, token);
}

function extractAdminToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7);
  }

  const adminHeader = request.headers["x-admin-token"];
  if (typeof adminHeader === "string") {
    return adminHeader;
  }

  return null;
}

async function ensureQueuedTrackPlaybackPrepared(
  state: Awaited<ReturnType<SessionService["buildSessionState"]>>,
  mediaService: MediaService
) {
  const pendingTrackIds = state.queue
    .filter((item) => {
      const track = item.track;
      return (
        !track.playbackReady &&
        !track.pendingJobStatus &&
        requiresSegmentedLosslessPlayback({
          extension: extname(track.originalFilename),
          mimeType: track.mimeType,
          codec: track.codec
        })
      );
    })
    .map((item) => item.track.trackId);

  if (pendingTrackIds.length === 0) {
    return false;
  }

  await Promise.allSettled(
    pendingTrackIds.map((trackId) => mediaService.ensureBrowserPlayableAsset(trackId))
  );
  return true;
}

async function requireAdmin(request: FastifyRequest, adminService: AdminService) {
  const adminToken = extractAdminToken(request);
  if (!adminToken) {
    const error = new Error("Missing admin token");
    // @ts-expect-error custom status code
    error.statusCode = 401;
    throw error;
  }

  return adminService.requireAdmin(adminToken);
}

const adminLoginSchema = z.object({
  username: z.string().trim().default("admin"),
  password: z.string().min(1)
});

function withPlaybackAuth(
  path: string,
  options: {
    sessionId: string;
    accessToken: string;
  }
) {
  const separator = path.includes("?") ? "&" : "?";
  const params = new URLSearchParams({
    sessionId: options.sessionId,
    accessToken: options.accessToken
  });
  return `${path}${separator}${params.toString()}`;
}

export async function registerRoutes(
  app: FastifyInstance,
  services: {
    authService: AuthService;
    adminService: AdminService;
    sessionService: SessionService;
    mediaService: MediaService;
    playbackAuthority: PlaybackAuthority;
    hub: RealtimeHub;
  }
) {
  app.get("/health", async () => ({ ok: true, time: Date.now() }));

  app.post("/api/admin/login", async (request) => {
    const input = adminLoginSchema.parse(request.body);
    return services.adminService.login(input);
  });

  app.get("/api/admin/overview", async (request) => {
    await requireAdmin(request, services.adminService);
    return services.adminService.listOverview();
  });

  app.delete("/api/admin/sessions/:id", async (request) => {
    await requireAdmin(request, services.adminService);
    const params = request.params as { id: string };
    services.hub.emitSessionError(params.id, {
      code: "session_deleted",
      message: "Session deleted by admin."
    });
    const result = await services.adminService.deleteSession(params.id);
    return result;
  });

  app.delete("/api/admin/tracks/:trackId", async (request) => {
    await requireAdmin(request, services.adminService);
    const params = request.params as { trackId: string };
    const result = await services.adminService.deleteTrack(params.trackId);
    services.hub.emitSessionError(result.sessionId, {
      code: "track_deleted",
      trackId: result.trackId,
      message: "Music deleted by admin."
    });
    return result;
  });

  app.post("/api/admin/wipe", async (request) => {
    await requireAdmin(request, services.adminService);
    const overview = await services.adminService.listOverview();
    for (const session of overview.sessions) {
      services.hub.emitSessionError(session.sessionId, {
        code: "session_deleted",
        message: "Session deleted by admin."
      });
    }
    return services.adminService.wipeAll();
  });

  app.post("/api/sessions", async (request, reply) => {
    const input = createSessionSchema.parse(request.body);
    const result = await services.sessionService.createSession(input);
    reply.send({
      accessToken: result.token,
      state: result.state
    });
  });

  app.get("/api/sessions", async () => {
    return services.sessionService.listJoinableSessions();
  });

  app.post("/api/sessions/:id/join", async (request, reply) => {
    const params = request.params as { id: string };
    const input = joinSessionSchema.parse(request.body);
    const result = await services.sessionService.joinSession(params.id, input);
    services.hub.emitSessionState(params.id, result.state);
    reply.send({
      accessToken: result.token,
      state: result.state
    });
  });

  app.get("/api/sessions/:id/state", async (request) => {
    const params = request.params as { id: string };
    const access = await requireAccess(request, services.authService, params.id);
    let state = await services.sessionService.buildSessionState(params.id, access.memberId);
    const queuedBackfill = await ensureQueuedTrackPlaybackPrepared(state, services.mediaService);
    if (queuedBackfill) {
      state = await services.sessionService.buildSessionState(params.id, access.memberId);
    }
    return state;
  });

  app.delete("/api/sessions/:id", async (request) => {
    const params = request.params as { id: string };
    const access = await requireAccess(request, services.authService, params.id);
    if (access.role !== "owner") {
      const error = new Error("Only owners can abandon a session");
      // @ts-expect-error custom status code
      error.statusCode = 403;
      throw error;
    }
    services.hub.emitSessionError(params.id, {
      code: "session_deleted",
      message: "Session abandoned."
    });
    return services.adminService.deleteSession(params.id);
  });

  app.post("/api/sessions/:id/uploads", async (request, reply) => {
    const params = request.params as { id: string };
    const access = await requireAccess(request, services.authService, params.id);
    const upload = await request.file();
    if (!upload) {
      reply.code(400).send({ message: "Expected multipart file upload" });
      return;
    }

    const result = await services.mediaService.handleUpload(params.id, access, {
      file: upload.file,
      filename: upload.filename,
      mimetype: upload.mimetype
    });
    await services.sessionService.mutateQueue(params.id, access, {
      type: "add",
      trackId: result.trackId
    });
    const state = await services.sessionService.buildSessionState(params.id, access.memberId);
    services.hub.emitSessionState(params.id, state);
    reply.code(201).send({ trackId: result.trackId, state });
  });

  app.post("/api/sessions/:id/queue", async (request) => {
    const params = request.params as { id: string };
    const access = await requireAccess(request, services.authService, params.id);
    const input = queueMutationSchema.parse(request.body);
    await services.sessionService.mutateQueue(params.id, access, input);
    const state = await services.sessionService.buildSessionState(params.id, access.memberId);
    services.hub.emitSessionState(params.id, state);
    return state;
  });

  app.post("/api/sessions/:id/control", async (request) => {
    const params = request.params as { id: string };
    const access = await requireAccess(request, services.authService, params.id);
    const input = playbackControlSchema.parse(request.body);
    const event = await services.playbackAuthority.applyControl(params.id, access, input);
    const state = await services.sessionService.buildSessionState(params.id, access.memberId);
    services.hub.emitTransportCommand(params.id, event);
    services.hub.emitSessionState(params.id, state);
    return { transport: event, state };
  });

  app.post("/api/sessions/:id/members/:memberId/role", async (request) => {
    const params = request.params as { id: string; memberId: string };
    const access = await requireAccess(request, services.authService, params.id);
    const input = updateMemberRoleSchema.parse(request.body);
    await services.sessionService.updateMemberRole(params.id, access, params.memberId, input);
    const state = await services.sessionService.buildSessionState(params.id, access.memberId);
    services.hub.emitSessionState(params.id, state);
    return state;
  });

  app.get("/api/tracks/:trackId/asset", async (request, reply) => {
    const params = request.params as { trackId: string };
    const rawQuery = request.query as Record<string, string | undefined>;
    const sessionId = rawQuery.sessionId;
    if (!sessionId) {
      reply.code(400).send({ message: "sessionId is required" });
      return;
    }

    const access = await requireAccess(request, services.authService, sessionId);
    const capabilities = clientCapabilitiesSchema.parse({
      mimeTypes: rawQuery.mimeTypes ? rawQuery.mimeTypes.split(",").filter(Boolean) : [],
      supportsFlac: rawQuery.supportsFlac === "true",
      supportsMp3: rawQuery.supportsMp3 !== "false",
      supportsWav: rawQuery.supportsWav !== "false",
      supportsAiff: rawQuery.supportsAiff === "true",
      supportsMseFlacSegmented: rawQuery.supportsMseFlacSegmented === "true"
    });

    const selection = await services.sessionService.resolveAsset(params.trackId, capabilities);
    if (!selection?.asset) {
      await services.mediaService.ensureBrowserPlayableAsset(params.trackId);
      reply.code(409).send({ message: "Track is still being prepared for browser playback" });
      return;
    }

    if (selection.mode === "lossless_chunked") {
      reply.send({
        mode: "lossless_chunked",
        assetId: selection.asset.id,
        status: selection.asset.status,
        chunkMimeType: "audio/flac",
        manifestUrl: `/api/tracks/${params.trackId}/manifests/${selection.asset.id}?sessionId=${sessionId}&accessToken=${access.token}`
      });
      return;
    }

    reply.send({
      mode: "direct_file",
      assetId: selection.asset.id,
      mimeType: selection.asset.mimeType,
      status: selection.asset.status,
      streamUrl: `/api/tracks/${params.trackId}/stream/${selection.asset.id}?sessionId=${sessionId}&accessToken=${access.token}`
    });
  });

  app.get("/api/tracks/:trackId/manifests/:assetId", async (request, reply) => {
    const params = request.params as { trackId: string; assetId: string };
    const rawQuery = request.query as Record<string, string | undefined>;
    const sessionId = rawQuery.sessionId;
    if (!sessionId) {
      reply.code(400).send({ message: "sessionId is required" });
      return;
    }

    const access = await requireAccess(request, services.authService, sessionId);
    const manifest = await services.mediaService.getPlaybackManifest(params.assetId);
    if (!manifest || manifest.trackId !== params.trackId) {
      reply.code(404).send({ message: "Manifest not found" });
      return;
    }

    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.send({
      ...manifest,
      ...(manifest.initSegmentUrl
        ? {
            initSegmentUrl: withPlaybackAuth(manifest.initSegmentUrl, {
              sessionId,
              accessToken: access.token
            })
          }
        : {}),
      segments: manifest.segments.map((segment) => ({
        ...segment,
        url: withPlaybackAuth(segment.url, {
          sessionId,
          accessToken: access.token
        })
      }))
    });
  });

  app.get("/api/tracks/:trackId/segments/:assetId/:segmentName", async (request, reply) => {
    const params = request.params as { trackId: string; assetId: string; segmentName: string };
    const rawQuery = request.query as Record<string, string | undefined>;
    if (!rawQuery.sessionId) {
      reply.code(400).send({ message: "sessionId is required" });
      return;
    }

    await requireAccess(request, services.authService, rawQuery.sessionId);
    const asset = await services.mediaService.getTrackAsset(params.assetId);
    if (!asset || asset.trackId !== params.trackId || asset.kind !== "streaming_playback") {
      reply.code(404).send({ message: "Streaming asset not found" });
      return;
    }

    const segmentPath = await services.mediaService.getPlaybackSegmentPath(params.assetId, params.segmentName);
    if (!segmentPath) {
      reply.code(404).send({ message: "Segment not found" });
      return;
    }

    const fileStats = await services.mediaService.getStreamStats(segmentPath);
    reply.header("Content-Type", asset.container === "flac_chunks" ? "audio/flac" : "audio/mp4");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Content-Length", String(fileStats.size));
    return reply.send(createReadStream(segmentPath));
  });

  app.get("/api/tracks/:trackId/stream/:assetId", async (request, reply) => {
    const params = request.params as { trackId: string; assetId: string };
    const rawQuery = request.query as Record<string, string | undefined>;
    if (!rawQuery.sessionId) {
      reply.code(400).send({ message: "sessionId is required" });
      return;
    }
    await requireAccess(request, services.authService, rawQuery.sessionId);

    const asset = await services.mediaService.getTrackAsset(params.assetId);
    if (!asset || asset.trackId !== params.trackId) {
      reply.code(404).send({ message: "Asset not found" });
      return;
    }

    const fileStats = await services.mediaService.getStreamStats(asset.storagePath);
    const total = fileStats.size;
    const rangeHeader = request.headers.range;
    let start = 0;
    let end = total - 1;

    if (rangeHeader?.startsWith("bytes=")) {
      const [rawStart, rawEnd] = rangeHeader.replace("bytes=", "").split("-");
      const parsedStart = rawStart ? Number(rawStart) : 0;
      const parsedEnd = rawEnd ? Number(rawEnd) : total - 1;

      if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedStart < 0 || parsedStart >= total) {
        reply.code(416);
        reply.header("Content-Range", `bytes */${total}`);
        reply.send({ message: "Invalid range" });
        return;
      }

      start = Math.max(0, parsedStart);
      end = Math.min(total - 1, Math.max(start, parsedEnd));
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
    }

    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", asset.mimeType);
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    reply.header("Content-Length", String(end - start + 1));
    return reply.send(createReadStream(asset.storagePath, { start, end }));
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    reply.code((error as { statusCode?: number }).statusCode ?? 500).send({
      message
    });
  });
}
