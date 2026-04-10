import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { Server } from "socket.io";
import { env } from "./config/env.js";
import { closeDatabase, db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { registerRoutes } from "./routes.js";
import { AuthService } from "./services/auth-service.js";
import { AdminService } from "./services/admin-service.js";
import { MediaService } from "./services/media-service.js";
import { PlaybackAuthority } from "./services/playback-authority.js";
import { RealtimeHub } from "./services/realtime-hub.js";
import { SessionService } from "./services/session-service.js";
import { MediaJobRunner } from "./workers/media-job-runner.js";
import { SessionIdleRunner } from "./workers/session-idle-runner.js";

function createCorsOriginValidator() {
  const configuredOrigins = env.CORS_ORIGIN.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowAllOrigins = configuredOrigins.length === 0 || configuredOrigins.includes("*");

  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    if (!origin || allowAllOrigins || configuredOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed`), false);
  };
}

export async function buildApp() {
  await runMigrations();
  const corsOriginValidator = createCorsOriginValidator();
  const app = Fastify({
    logger: true,
    bodyLimit: env.MAX_UPLOAD_BYTES
  });
  await app.register(cors, {
    origin: corsOriginValidator as any,
    credentials: true
  });
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 16
    }
  });

  const authService = new AuthService(db, env.STREAM_TOKEN_TTL_SECONDS);
  const adminService = new AdminService(db);
  const sessionService = new SessionService(db, authService, adminService);
  const mediaService = new MediaService(db);
  const playbackAuthority = new PlaybackAuthority(db);
  const hub = new RealtimeHub();

  await registerRoutes(app, {
    authService,
    adminService,
    sessionService,
    mediaService,
    playbackAuthority,
    hub
  });

  const io = new Server(app.server, {
    cors: {
      origin: corsOriginValidator as any,
      credentials: true
    }
  });
  hub.attach(io);

  io.on("connection", (socket) => {
    socket.on("session:join", async (payload: { sessionId: string; accessToken: string }) => {
      try {
        const access = await authService.getSessionAccess(payload.sessionId, payload.accessToken);
        await socket.join(hub.roomName(payload.sessionId));
        const state = await sessionService.buildSessionState(payload.sessionId, access.memberId);
        socket.emit("session:state", state);
      } catch (error) {
        socket.emit("session:error", {
          message: error instanceof Error ? error.message : "Unable to join session"
        });
      }
    });

    socket.on("transport:drift", (payload) => {
      socket.broadcast.emit("transport:drift", payload);
    });
  });

  const mediaJobRunner = new MediaJobRunner(mediaService, hub);
  const sessionIdleRunner = new SessionIdleRunner(db, adminService, hub);

  app.addHook("onReady", async () => {
    await mediaService.ensureStorageRoots();
    mediaJobRunner.start();
    sessionIdleRunner.start();
  });

  app.addHook("onClose", async () => {
    mediaJobRunner.stop();
    sessionIdleRunner.stop();
    io.close();
    await closeDatabase();
  });

  return app;
}
