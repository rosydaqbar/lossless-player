import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { PlaybackControlInput } from "@lossless-player/contracts";
import type { AppDatabase } from "../db/client.js";
import { auditEvents, playbackState, queueItems } from "../db/schema.js";
import { canManagePlayback, computeCurrentPositionMs } from "../lib/playback.js";
import type { SessionAccessContext } from "./auth-service.js";

type Database = AppDatabase;

export class PlaybackAuthority {
  constructor(private readonly database: Database) {}

  async applyControl(sessionId: string, actor: SessionAccessContext, input: PlaybackControlInput) {
    if (!canManagePlayback(actor.role)) {
      throw new Error("Playback control requires controller access");
    }

    return this.database.transaction(async (tx: any) => {
      const [transport] = await tx.select().from(playbackState).where(eq(playbackState.sessionId, sessionId));
      const queue = await tx
        .select()
        .from(queueItems)
        .where(eq(queueItems.sessionId, sessionId))
        .orderBy(asc(queueItems.position));

      if (!transport) {
        throw new Error("Playback state not initialized");
      }

      if (transport.revision !== input.revision) {
        const error = new Error("Playback revision conflict");
        // @ts-expect-error custom status
        error.statusCode = 409;
        throw error;
      }

      const now = Date.now();
      const selectedQueue = queue.find((item: any) => item.isSelected) ?? queue[0];
      const selectedIndex = queue.findIndex((item: any) => item.isSelected);
      const currentIndex =
        selectedIndex >= 0 ? selectedIndex : queue.findIndex((item: any) => item.trackId === transport.trackId);
      let nextTrackId = transport.trackId;
      let nextStatus = transport.status;
      let nextPosition = transport.basePositionMs;
      let effectiveAtMs = now;
      const normalizePositionMs = (value: number) => Math.max(0, Math.round(value));

      if (input.action === "play") {
        nextTrackId = transport.trackId ?? selectedQueue?.trackId ?? null;
        if (!nextTrackId) {
          throw new Error("Queue is empty");
        }
        nextStatus = "playing";
        effectiveAtMs = now + 1200;
      }

      if (input.action === "pause") {
        nextStatus = "paused";
        nextPosition = normalizePositionMs(input.positionMs ?? computeCurrentPositionMs(transport, now));
        effectiveAtMs = now;
      }

      if (input.action === "stop") {
        nextTrackId = null;
        nextStatus = "idle";
        nextPosition = 0;
        effectiveAtMs = now;
      }

      if (input.action === "seek") {
        nextStatus = transport.status;
        nextPosition = normalizePositionMs(input.positionMs);
        effectiveAtMs = transport.status === "playing" ? now + 300 : now;
      }

      if (input.action === "next" || input.action === "previous") {
        if (!queue.length) {
          throw new Error("Queue is empty");
        }
        const fallbackIndex = currentIndex >= 0 ? currentIndex : 0;

        if (input.action === "next" && fallbackIndex >= queue.length - 1) {
          nextTrackId = null;
          nextPosition = 0;
          nextStatus = "idle";
          effectiveAtMs = now;
        } else {
          const offset = input.action === "next" ? 1 : -1;
          const boundedIndex = Math.min(queue.length - 1, Math.max(0, fallbackIndex + offset));
          const target = queue[boundedIndex];
          nextTrackId = target.trackId;
          nextPosition = 0;
          nextStatus = transport.status === "playing" ? "playing" : "paused";
          effectiveAtMs = nextStatus === "playing" ? now + 1200 : now;

          for (const item of queue) {
            await tx.update(queueItems).set({ isSelected: item.id === target.id }).where(eq(queueItems.id, item.id));
          }
        }
      }

      await tx
        .update(playbackState)
        .set({
          trackId: nextTrackId,
          status: nextStatus,
          basePositionMs: normalizePositionMs(nextPosition),
          effectiveAtMs,
          revision: transport.revision + 1,
          updatedAt: new Date(),
          updatedByMemberId: actor.memberId
        })
        .where(eq(playbackState.sessionId, sessionId));

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId,
        memberId: actor.memberId,
        eventType: "transport.updated",
        payload: input
      });

      return {
        sessionId,
        trackId: nextTrackId,
        status: nextStatus,
        positionMs: normalizePositionMs(nextPosition),
        revision: transport.revision + 1,
        serverTimeMs: now,
        effectiveAtMs,
        issuedByMemberId: actor.memberId
      };
    });
  }
}
