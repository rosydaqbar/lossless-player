import { and, eq, lte, ne } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { env } from "../config/env.js";
import { playbackState, sessions } from "../db/schema.js";
import { AdminService } from "../services/admin-service.js";
import { RealtimeHub } from "../services/realtime-hub.js";

type Database = AppDatabase;

export class SessionIdleRunner {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly adminService: AdminService,
    private readonly hub: RealtimeHub
  ) {}

  start() {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.tick().catch((error) => console.error("session idle runner tick failed", error));
    }, env.SESSION_IDLE_SWEEP_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async tick() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const cutoff = new Date(Date.now() - env.SESSION_IDLE_DESTROY_MS);
      const expiredSessions = await this.database
        .select({
          sessionId: sessions.id
        })
        .from(sessions)
        .innerJoin(playbackState, eq(playbackState.sessionId, sessions.id))
        .where(and(ne(playbackState.status, "playing"), lte(playbackState.updatedAt, cutoff)));

      for (const entry of expiredSessions) {
        this.hub.emitSessionError(entry.sessionId, {
          code: "session_deleted",
          message: "Session deleted after 5 minutes without playback."
        });

        try {
          await this.adminService.deleteSession(entry.sessionId);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Session not found") {
            throw error;
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
