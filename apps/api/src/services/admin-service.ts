import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import {
  accessTokens,
  auditEvents,
  mediaJobs,
  playbackState,
  queueItems,
  sessionMembers,
  sessions,
  trackAssets,
  tracks,
  users
} from "../db/schema.js";

type Database = AppDatabase;

type AdminTokenRecord = {
  token: string;
  expiresAt: number;
};

type DeleteTrackOptions = {
  memberId?: string | null;
  eventType?: string;
};

function unauthorizedError(message: string) {
  const error = new Error(message);
  // @ts-expect-error custom status code
  error.statusCode = 401;
  return error;
}

function notFoundError(message: string) {
  const error = new Error(message);
  // @ts-expect-error custom status code
  error.statusCode = 404;
  return error;
}

export class AdminService {
  private readonly adminTokens = new Map<string, AdminTokenRecord>();

  constructor(private readonly database: Database) {}

  private issueToken() {
    const token = `${randomUUID()}${randomUUID().replaceAll("-", "")}`;
    this.adminTokens.set(token, {
      token,
      expiresAt: Date.now() + env.ADMIN_TOKEN_TTL_SECONDS * 1000
    });
    return token;
  }

  async login(input: { username?: string; password: string }) {
    const username = input.username?.trim() || env.ADMIN_USERNAME;
    if (username !== env.ADMIN_USERNAME || input.password !== env.ADMIN_PASSWORD) {
      throw unauthorizedError("Invalid admin credentials");
    }

    return {
      adminToken: this.issueToken(),
      username: env.ADMIN_USERNAME
    };
  }

  async requireAdmin(adminToken: string) {
    const record = this.adminTokens.get(adminToken);
    if (!record || record.expiresAt < Date.now()) {
      this.adminTokens.delete(adminToken);
      throw unauthorizedError("Admin authorization required");
    }

    return {
      username: env.ADMIN_USERNAME
    };
  }

  async listOverview() {
    const [sessionRows, memberRows, queueRows, trackRows, assetRows, playbackRows] = await Promise.all([
      this.database.select().from(sessions),
      this.database.select().from(sessionMembers),
      this.database.select().from(queueItems).orderBy(asc(queueItems.position)),
      this.database.select().from(tracks),
      this.database.select().from(trackAssets),
      this.database.select().from(playbackState)
    ]);

    const trackById = new Map(trackRows.map((track: any) => [track.id, track]));
    const sessionById = new Map(sessionRows.map((session: any) => [session.id, session]));
    const memberCountBySession = new Map<string, number>();
    const queueCountBySession = new Map<string, number>();
    const trackCountBySession = new Map<string, number>();
    const assetCountByTrack = new Map<string, number>();
    const playbackBySession = new Map(playbackRows.map((item: any) => [item.sessionId, item]));

    for (const member of memberRows) {
      memberCountBySession.set(member.sessionId, (memberCountBySession.get(member.sessionId) ?? 0) + 1);
    }

    for (const queueItem of queueRows) {
      queueCountBySession.set(queueItem.sessionId, (queueCountBySession.get(queueItem.sessionId) ?? 0) + 1);
    }

    for (const track of trackRows) {
      trackCountBySession.set(track.sessionId, (trackCountBySession.get(track.sessionId) ?? 0) + 1);
    }

    for (const asset of assetRows) {
      assetCountByTrack.set(asset.trackId, (assetCountByTrack.get(asset.trackId) ?? 0) + 1);
    }

    return {
      summary: {
        sessionCount: sessionRows.length,
        trackCount: trackRows.length,
        assetCount: assetRows.length
      },
      sessions: sessionRows
        .map((session: any) => {
          const playback = playbackBySession.get(session.id) as any;
          const currentTrack = playback?.trackId ? (trackById.get(playback.trackId) as any) : null;
          return {
            sessionId: session.id,
            sessionName: session.name,
            listenerCode: session.listenerCode,
            controllerCode: session.controllerCode,
            memberCount: memberCountBySession.get(session.id) ?? 0,
            queueCount: queueCountBySession.get(session.id) ?? 0,
            trackCount: trackCountBySession.get(session.id) ?? 0,
            playbackStatus: playback?.status ?? "idle",
            currentTrackTitle: currentTrack?.displayTitle ?? null,
            createdAt: session.createdAt.toISOString()
          };
        })
        .sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt)),
      tracks: trackRows
        .map((track: any) => ({
          trackId: track.id,
          sessionId: track.sessionId,
          sessionName: (sessionById.get(track.sessionId) as any)?.name ?? "Deleted session",
          displayTitle: track.displayTitle,
          originalFilename: track.originalFilename,
          mimeType: track.mimeType,
          codec: track.codec,
          sampleRate: track.sampleRate,
          bitDepth: track.bitDepth,
          channels: track.channels,
          durationMs: track.durationMs,
          assetCount: assetCountByTrack.get(track.id) ?? 0,
          createdAt: track.createdAt.toISOString()
        }))
        .sort((left: any, right: any) => right.createdAt.localeCompare(left.createdAt))
    };
  }

  private async cleanupTrackFiles(trackId: string) {
    await Promise.all([
      rm(join(env.storageRoot, "originals", trackId), { recursive: true, force: true }),
      rm(join(env.storageRoot, "normalized", trackId), { recursive: true, force: true }),
      rm(join(env.storageRoot, "streaming", trackId), { recursive: true, force: true })
    ]);
  }

  private async cleanupMediaStorage() {
    const entries = await readdir(env.storageRoot, { withFileTypes: true }).catch(() => []);
    const protectedEntryName = basename(env.pgliteDataDir);

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === protectedEntryName) {
          return;
        }

        await rm(join(env.storageRoot, entry.name), {
          recursive: true,
          force: true
        });
      })
    );

    await Promise.all([
      mkdir(join(env.storageRoot, "originals"), { recursive: true }),
      mkdir(join(env.storageRoot, "normalized"), { recursive: true }),
      mkdir(join(env.storageRoot, "streaming"), { recursive: true })
    ]);
  }

  async deleteTrack(trackId: string, options: DeleteTrackOptions = {}) {
    const [track] = await this.database.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) {
      throw notFoundError("Track not found");
    }

    const memberId = options.memberId ?? null;
    const eventType = options.eventType ?? "admin.track_deleted";
    const now = Date.now();

    await this.database.transaction(async (tx: any) => {
      const queue = await tx
        .select()
        .from(queueItems)
        .where(eq(queueItems.sessionId, track.sessionId))
        .orderBy(asc(queueItems.position));
      const [transport] = await tx.select().from(playbackState).where(eq(playbackState.sessionId, track.sessionId));

      const remaining = queue.filter((item: any) => item.trackId !== trackId);
      const removedSelected = queue.some((item: any) => item.trackId === trackId && item.isSelected);

      await tx.delete(queueItems).where(eq(queueItems.trackId, trackId));

      for (const [index, item] of remaining.entries()) {
        const shouldSelect = removedSelected ? index === 0 : item.isSelected;
        await tx
          .update(queueItems)
          .set({ position: index, isSelected: shouldSelect })
          .where(eq(queueItems.id, item.id));
      }

      if (transport?.trackId === trackId) {
        await tx
          .update(playbackState)
          .set({
            trackId: null,
            status: "idle",
            basePositionMs: 0,
            effectiveAtMs: now,
            revision: transport.revision + 1,
            updatedAt: new Date(),
            updatedByMemberId: null
          })
          .where(eq(playbackState.sessionId, track.sessionId));
      }

      await tx.delete(mediaJobs).where(eq(mediaJobs.trackId, trackId));
      await tx.delete(trackAssets).where(eq(trackAssets.trackId, trackId));
      await tx.delete(tracks).where(eq(tracks.id, trackId));
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId: track.sessionId,
        memberId,
        eventType,
        payload: { trackId }
      });
    });

    await this.cleanupTrackFiles(trackId);

    return {
      sessionId: track.sessionId,
      trackId
    };
  }

  async deleteSession(sessionId: string) {
    const [session] = await this.database.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session) {
      throw notFoundError("Session not found");
    }

    const trackRows = await this.database.select().from(tracks).where(eq(tracks.sessionId, sessionId));
    const trackIds = trackRows.map((track: any) => track.id);
    const memberRows = await this.database.select().from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId));
    const memberUserIds = memberRows.map((member: any) => member.userId);

    await this.database.transaction(async (tx: any) => {
      await tx.delete(accessTokens).where(eq(accessTokens.sessionId, sessionId));
      await tx.delete(queueItems).where(eq(queueItems.sessionId, sessionId));
      await tx.delete(playbackState).where(eq(playbackState.sessionId, sessionId));
      await tx.delete(mediaJobs).where(eq(mediaJobs.sessionId, sessionId));
      for (const trackId of trackIds) {
        await tx.delete(trackAssets).where(eq(trackAssets.trackId, trackId));
      }
      await tx.delete(tracks).where(eq(tracks.sessionId, sessionId));
      await tx.delete(auditEvents).where(eq(auditEvents.sessionId, sessionId));
      await tx.delete(sessionMembers).where(eq(sessionMembers.sessionId, sessionId));
      await tx.delete(sessions).where(eq(sessions.id, sessionId));

      for (const userId of memberUserIds) {
        const [stillJoined] = await tx.select().from(sessionMembers).where(eq(sessionMembers.userId, userId));
        if (!stillJoined) {
          await tx.delete(users).where(eq(users.id, userId));
        }
      }
    });

    await Promise.all(trackIds.map((trackId: string) => this.cleanupTrackFiles(trackId)));

    return {
      sessionId
    };
  }

  async wipeAll() {
    const sessionRows = await this.database.select().from(sessions);

    await this.database.transaction(async (tx: any) => {
      await tx.delete(accessTokens);
      await tx.delete(queueItems);
      await tx.delete(playbackState);
      await tx.delete(mediaJobs);
      await tx.delete(trackAssets);
      await tx.delete(tracks);
      await tx.delete(auditEvents);
      await tx.delete(sessionMembers);
      await tx.delete(sessions);
      await tx.delete(users);
    });

    await this.cleanupMediaStorage();

    return {
      deletedSessionIds: sessionRows.map((session: any) => session.id)
    };
  }
}
