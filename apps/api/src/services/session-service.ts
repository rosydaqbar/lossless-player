import { randomBytes, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  ClientCapabilities,
  CreateSessionInput,
  JoinSessionInput,
  QueueMutationInput,
  SessionState,
  UpdateMemberRoleInput
} from "@lossless-player/contracts";
import type { AppDatabase } from "../db/client.js";
import {
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
import {
  isDirectPlayMime,
  needsBrowserPlaybackDerivative,
  pickBestAsset
} from "../lib/playback.js";
import { AdminService } from "./admin-service.js";
import { AuthService, type SessionAccessContext } from "./auth-service.js";

type Database = AppDatabase;

function makeCode(prefix: string) {
  return `${prefix}-${randomBytes(3).toString("hex")}`;
}

export class SessionService {
  constructor(
    private readonly database: Database,
    private readonly authService: AuthService,
    private readonly adminService: AdminService
  ) {}

  async listJoinableSessions() {
    const sessionRows = await this.database.select().from(sessions).orderBy(desc(sessions.createdAt));
    if (!sessionRows.length) {
      return [];
    }

    const sessionIds = sessionRows.map((session: any) => session.id);
    const ownerRows = await this.database
      .select({
        sessionId: sessionMembers.sessionId,
        ownerDisplayName: users.displayName
      })
      .from(sessionMembers)
      .innerJoin(users, eq(sessionMembers.userId, users.id))
      .where(and(inArray(sessionMembers.sessionId, sessionIds), eq(sessionMembers.role, "owner")));

    const memberRows = await this.database
      .select({
        sessionId: sessionMembers.sessionId
      })
      .from(sessionMembers)
      .where(and(inArray(sessionMembers.sessionId, sessionIds), eq(sessionMembers.isActive, true)));

    const trackRows = await this.database
      .select({
        sessionId: tracks.sessionId
      })
      .from(tracks)
      .where(inArray(tracks.sessionId, sessionIds));

    const ownerBySession = new Map(ownerRows.map((row: any) => [row.sessionId, row.ownerDisplayName]));
    const memberCountBySession = new Map<string, number>();
    const trackCountBySession = new Map<string, number>();

    for (const row of memberRows) {
      memberCountBySession.set(row.sessionId, (memberCountBySession.get(row.sessionId) ?? 0) + 1);
    }

    for (const row of trackRows) {
      trackCountBySession.set(row.sessionId, (trackCountBySession.get(row.sessionId) ?? 0) + 1);
    }

    return sessionRows.map((session: any) => ({
      sessionId: session.id,
      sessionName: session.name,
      ownerDisplayName: ownerBySession.get(session.id) ?? "Unknown owner",
      memberCount: memberCountBySession.get(session.id) ?? 0,
      trackCount: trackCountBySession.get(session.id) ?? 0,
      createdAt: session.createdAt.toISOString()
    }));
  }

  async createSession(input: CreateSessionInput) {
    const sessionId = randomUUID();
    const userId = randomUUID();
    const memberId = randomUUID();

    await this.database.transaction(async (tx: any) => {
      await tx.insert(users).values({
        id: userId,
        displayName: input.displayName
      });

      await tx.insert(sessions).values({
        id: sessionId,
        name: input.sessionName,
        listenerCode: makeCode("listen"),
        controllerCode: makeCode("ctrl"),
        createdByUserId: userId
      });

      await tx.insert(sessionMembers).values({
        id: memberId,
        sessionId,
        userId,
        role: "owner"
      });

      await tx.insert(playbackState).values({
        sessionId,
        status: "idle",
        basePositionMs: 0,
        effectiveAtMs: 0,
        revision: 0
      });

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId,
        memberId,
        eventType: "session.created",
        payload: { sessionName: input.sessionName }
      });
    });

    const token = await this.authService.issueAccessToken(sessionId, memberId);
    const state = await this.buildSessionState(sessionId, memberId);
    return { token, state };
  }

  async joinSession(sessionId: string, input: JoinSessionInput) {
    const [session] = await this.database.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session) {
      throw new Error("Session not found");
    }

    let role = "listener";
    if (input.accessCode === session.controllerCode) {
      role = "controller";
    } else if (input.accessCode !== session.listenerCode) {
      throw new Error("Invalid access code");
    }

    const userId = randomUUID();
    const memberId = randomUUID();

    await this.database.transaction(async (tx: any) => {
      await tx.insert(users).values({
        id: userId,
        displayName: input.displayName
      });

      await tx.insert(sessionMembers).values({
        id: memberId,
        sessionId,
        userId,
        role
      });

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId,
        memberId,
        eventType: "session.joined",
        payload: { role }
      });
    });

    const token = await this.authService.issueAccessToken(sessionId, memberId);
    const state = await this.buildSessionState(sessionId, memberId);
    return { token, state };
  }

  async updateMemberRole(sessionId: string, actor: SessionAccessContext, targetMemberId: string, input: UpdateMemberRoleInput) {
    if (actor.role !== "owner") {
      throw new Error("Only owners can change roles");
    }

    const [target] = await this.database
      .select()
      .from(sessionMembers)
      .where(and(eq(sessionMembers.id, targetMemberId), eq(sessionMembers.sessionId, sessionId)));

    if (!target) {
      throw new Error("Member not found");
    }

    if (target.role === "owner") {
      throw new Error("Owner role cannot be reassigned");
    }

    await this.database
      .update(sessionMembers)
      .set({ role: input.role, updatedAt: new Date() })
      .where(eq(sessionMembers.id, targetMemberId));

    await this.database.insert(auditEvents).values({
      id: randomUUID(),
      sessionId,
      memberId: actor.memberId,
      eventType: "member.role_updated",
      payload: { targetMemberId, role: input.role }
    });
  }

  async mutateQueue(sessionId: string, actor: SessionAccessContext, input: QueueMutationInput) {
    if (!(actor.role === "owner" || actor.role === "controller")) {
      throw new Error("Queue control requires controller access");
    }

    if (input.type === "remove") {
      const queue = await this.database
        .select()
        .from(queueItems)
        .where(eq(queueItems.sessionId, sessionId))
        .orderBy(asc(queueItems.position));
      const removed = queue.find((item: any) => item.id === input.queueItemId);

      if (!removed) {
        throw new Error("Queue item not found");
      }

      await this.adminService.deleteTrack(removed.trackId, {
        memberId: actor.memberId,
        eventType: "queue.track_removed"
      });
      return;
    }

    await this.database.transaction(async (tx: any) => {
      const queue = await tx
        .select()
        .from(queueItems)
        .where(eq(queueItems.sessionId, sessionId))
        .orderBy(asc(queueItems.position));

      if (input.type === "add") {
        const last = queue[queue.length - 1];
        await tx.insert(queueItems).values({
          id: randomUUID(),
          sessionId,
          trackId: input.trackId,
          position: last ? last.position + 1 : 0,
          isSelected: queue.length === 0,
          addedByMemberId: actor.memberId
        });
      }

      if (input.type === "move") {
        const moving = queue.find((item: any) => item.id === input.queueItemId);
        if (!moving) {
          throw new Error("Queue item not found");
        }
        const next = queue.filter((item: any) => item.id !== input.queueItemId);
        next.splice(input.toIndex, 0, moving);
        for (const [index, item] of next.entries()) {
          await tx.update(queueItems).set({ position: index }).where(eq(queueItems.id, item.id));
        }
      }

      if (input.type === "select") {
        const selected = queue.find((item: any) => item.id === input.queueItemId);
        if (!selected) {
          throw new Error("Queue item not found");
        }

        for (const item of queue) {
          await tx.update(queueItems).set({ isSelected: item.id === input.queueItemId }).where(eq(queueItems.id, item.id));
        }

        const [transport] = await tx.select().from(playbackState).where(eq(playbackState.sessionId, sessionId));
        if (!transport) {
          throw new Error("Playback state not initialized");
        }

        const now = Date.now();
        const nextStatus = transport.status === "playing" ? "playing" : "paused";
        const effectiveAtMs = nextStatus === "playing" ? now + 1200 : now;

        await tx
          .update(playbackState)
          .set({
            trackId: selected.trackId,
            status: nextStatus,
            basePositionMs: 0,
            effectiveAtMs,
            revision: transport.revision + 1,
            updatedAt: new Date(),
            updatedByMemberId: actor.memberId
          })
          .where(eq(playbackState.sessionId, sessionId));
      }

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId,
        memberId: actor.memberId,
        eventType: "queue.updated",
        payload: input
      });
    });
  }

  async buildSessionState(sessionId: string, currentMemberId: string): Promise<SessionState> {
    const [session] = await this.database.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session) {
      throw new Error("Session not found");
    }

    const memberRows = await this.database
      .select({
        memberId: sessionMembers.id,
        userId: sessionMembers.userId,
        displayName: users.displayName,
        role: sessionMembers.role,
        joinedAt: sessionMembers.joinedAt,
        isActive: sessionMembers.isActive
      })
      .from(sessionMembers)
      .innerJoin(users, eq(sessionMembers.userId, users.id))
      .where(eq(sessionMembers.sessionId, sessionId))
      .orderBy(asc(sessionMembers.joinedAt));

    const [transport] = await this.database.select().from(playbackState).where(eq(playbackState.sessionId, sessionId));
    const queueRows = await this.database
      .select()
      .from(queueItems)
      .where(eq(queueItems.sessionId, sessionId))
      .orderBy(asc(queueItems.position));

    const trackIds = queueRows.map((item: any) => item.trackId);
    const trackRows = trackIds.length
      ? await this.database.select().from(tracks).where(inArray(tracks.id, trackIds))
      : [];
    const assetRows = trackIds.length
      ? await this.database.select().from(trackAssets).where(inArray(trackAssets.trackId, trackIds))
      : [];
    const pendingJobs = trackIds.length
      ? await this.database.select().from(mediaJobs).where(inArray(mediaJobs.trackId, trackIds)).orderBy(desc(mediaJobs.updatedAt))
      : [];

    const assetsByTrack = new Map<string, typeof assetRows>();
    for (const asset of assetRows) {
      assetsByTrack.set(asset.trackId, [...(assetsByTrack.get(asset.trackId) ?? []), asset]);
    }

    const pendingByTrack = new Map<string, (typeof pendingJobs)[number]>();
    for (const job of pendingJobs) {
      if (!pendingByTrack.has(job.trackId) && job.status !== "complete") {
        pendingByTrack.set(job.trackId, job);
      }
    }

    const trackById = new Map(
      trackRows.map((track: any) => [
        track.id,
        (() => {
          const trackAssetsForTrack = assetsByTrack.get(track.id) ?? [];
          const playbackReady = trackAssetsForTrack.some(
            (asset: any) =>
              asset.status === "complete" &&
              (
                (asset.kind === "original" && isDirectPlayMime(asset.mimeType)) ||
                (asset.kind === "normalized_playback" && isDirectPlayMime(asset.mimeType)) ||
                (asset.kind === "streaming_playback" && asset.container === "flac_chunks")
              )
          );

          return {
          trackId: track.id,
          originalFilename: track.originalFilename,
          displayTitle: track.displayTitle,
          artist: track.artist,
          album: track.album,
          durationMs: track.durationMs,
          mimeType: track.mimeType,
          codec: track.codec,
          sampleRate: track.sampleRate,
          bitDepth: track.bitDepth,
          channels: track.channels,
          playbackReady,
          pendingJobStatus:
            (pendingByTrack.get(track.id)?.status as "pending" | "processing" | "complete" | "failed" | null | undefined) ??
            null,
          assets: trackAssetsForTrack.map((asset: any) => ({
            assetId: asset.id,
            kind: asset.kind as "original" | "normalized_playback" | "streaming_playback" | "artwork",
            mimeType: asset.mimeType,
            codec: asset.codec,
            container: asset.container,
            sampleRate: asset.sampleRate,
            bitDepth: asset.bitDepth,
            channels: asset.channels,
            status: asset.status as "pending" | "processing" | "complete" | "failed"
          }))
        };
        })()
      ])
    );

    const currentMember = memberRows.find((member: any) => member.memberId === currentMemberId);
    if (!currentMember) {
      throw new Error("Current member not found");
    }

    return {
      sessionId: session.id,
      sessionName: session.name,
      listenerCode: currentMember.role === "owner" ? session.listenerCode : null,
      controllerCode: currentMember.role === "owner" ? session.controllerCode : null,
      currentMember: {
        ...currentMember,
        role: currentMember.role as "owner" | "controller" | "listener",
        joinedAt: currentMember.joinedAt.toISOString()
      },
      members: memberRows.map((member: any) => ({
        ...member,
        role: member.role as "owner" | "controller" | "listener",
        joinedAt: member.joinedAt.toISOString()
      })),
      queue: queueRows.map((item: any) => ({
        queueItemId: item.id,
        sessionId: item.sessionId,
        trackId: item.trackId,
        position: item.position,
        isSelected: item.isSelected,
        track: trackById.get(item.trackId)!
      })),
      transport: {
        sessionId: transport.sessionId,
        trackId: transport.trackId,
        status: transport.status as "idle" | "playing" | "paused",
        basePositionMs: transport.basePositionMs,
        effectiveAtMs: transport.effectiveAtMs,
        revision: transport.revision,
        updatedAt: transport.updatedAt.toISOString(),
        updatedByMemberId: transport.updatedByMemberId
      },
      serverTimeMs: Date.now()
    };
  }

  async resolveAsset(trackId: string, capabilities: ClientCapabilities) {
    const [track] = await this.database.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) {
      return null;
    }

    const assets = await this.database.select().from(trackAssets).where(eq(trackAssets.trackId, trackId));
    const selected = pickBestAsset(
      {
        track: {
          extension: extname(track.originalFilename),
          mimeType: track.mimeType,
          codec: track.codec
        },
        assets: assets.map((asset: any) => ({
          assetId: asset.id,
          kind: asset.kind,
          status: asset.status,
          mimeType: asset.mimeType,
          container: asset.container,
          codec: asset.codec,
          sampleRate: asset.sampleRate,
          bitDepth: asset.bitDepth
        })),
        capabilities
      }
    );

    if (!selected) {
      return null;
    }

    if (selected.mode === "unsupported") {
      const error = new Error(selected.reason);
      // @ts-expect-error custom status code
      error.statusCode = 412;
      throw error;
    }

    return {
      mode: selected.mode,
      asset: assets.find((asset: any) => asset.id === selected.asset.assetId) ?? null
    };
  }

  currentExtension(filename: string) {
    return extname(filename).toLowerCase();
  }
}
