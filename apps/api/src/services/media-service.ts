import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";
import { asc, eq, inArray } from "drizzle-orm";
import type { PlaybackManifest } from "@lossless-player/contracts";
import type { AppDatabase } from "../db/client.js";
import { env } from "../config/env.js";
import { auditEvents, mediaJobs, trackAssets, tracks } from "../db/schema.js";
import {
  isMp3Like,
  needsBrowserPlaybackDerivative,
  requiresSegmentedLosslessPlayback
} from "../lib/playback.js";
import type { SessionAccessContext } from "./auth-service.js";

type Database = AppDatabase;

const DEFAULT_STREAMING_SEGMENT_DURATION_SECONDS = 12;
const DEFAULT_STREAMING_SEGMENT_DURATION_MS = DEFAULT_STREAMING_SEGMENT_DURATION_SECONDS * 1000;
const STREAMING_CHUNK_MIME = "audio/flac";
const STREAMING_STORAGE_CONTAINER = "flac_chunks";
const TARGET_DECODED_CHUNK_BYTES = 6 * 1024 * 1024;
const MAX_HIFI_SAMPLE_RATE = 192000;
const MAX_HIFI_BIT_DEPTH = 24;

function resolveArtworkFileExtension(mimeType: string | null | undefined) {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return ".jpg";
  }
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  return ".img";
}

function pickEmbeddedArtwork(metadata: Awaited<ReturnType<typeof parseFile>>) {
  const pictures = metadata.common.picture ?? [];
  if (!pictures.length) {
    return null;
  }

  return pictures
    .filter((picture) => picture?.data?.length && picture?.format)
    .sort((a, b) => b.data.length - a.data.length)[0] ?? null;
}

function clampHiFiSampleRate(sampleRate: number | null | undefined) {
  const value = Number(sampleRate ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(MAX_HIFI_SAMPLE_RATE, Math.round(value));
}

function clampHiFiBitDepth(bitDepth: number | null | undefined) {
  const value = Number(bitDepth ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(MAX_HIFI_BIT_DEPTH, Math.round(value));
}

function resolveFfmpegSampleFormat(bitDepth: number | null | undefined) {
  const value = clampHiFiBitDepth(bitDepth);
  if (!value) {
    return null;
  }

  return value <= 16 ? "s16" : "s32";
}

function resolveFfmpegRawBitDepth(bitDepth: number | null | undefined) {
  const value = clampHiFiBitDepth(bitDepth);
  if (!value) {
    return null;
  }

  return value <= 16 ? 16 : 24;
}

function computeBrowserPlaybackTargets(input: {
  sampleRate?: number | null;
  bitDepth?: number | null;
  extension?: string | null;
  codec?: string | null;
}) {
  const rawSampleRate = Number(input.sampleRate ?? 0);
  const rawBitDepth = Number(input.bitDepth ?? 0);
  const extension = input.extension?.toLowerCase() ?? "";
  const codec = input.codec?.toLowerCase() ?? "";

  if (extension === ".dsf" || extension === ".dff" || codec.includes("dsd")) {
    return {
      sampleRate: MAX_HIFI_SAMPLE_RATE,
      bitDepth: MAX_HIFI_BIT_DEPTH
    };
  }

  return {
    sampleRate: clampHiFiSampleRate(rawSampleRate),
    bitDepth: clampHiFiBitDepth(rawBitDepth)
  };
}

function inferMimeType(input: {
  filename: string;
  uploadMimeType: string;
  codec: string | null | undefined;
  container: string | null | undefined;
}) {
  const extension = extname(input.filename).toLowerCase();
  const codec = input.codec?.toLowerCase() ?? "";
  const container = input.container?.toLowerCase() ?? "";
  const uploadMimeType = input.uploadMimeType?.toLowerCase() ?? "";

  if (uploadMimeType && uploadMimeType !== "application/octet-stream") {
    if (uploadMimeType === "audio/x-flac") {
      return "audio/flac";
    }
    if (uploadMimeType === "audio/x-wav" || uploadMimeType === "audio/wave" || uploadMimeType === "audio/vnd.wave") {
      return "audio/wav";
    }
    if (uploadMimeType === "audio/mp4" && codec.includes("alac")) {
      return "audio/alac";
    }
    return uploadMimeType;
  }

  if (extension === ".flac" || codec.includes("flac") || container.includes("flac")) {
    return "audio/flac";
  }
  if (extension === ".mp3" || codec.includes("mpeg") || codec.includes("mp3")) {
    return "audio/mpeg";
  }
  if (extension === ".wav" || container.includes("wave") || container.includes("wav") || codec.includes("pcm")) {
    return "audio/wav";
  }
  if (extension === ".aif" || extension === ".aiff" || container.includes("aiff")) {
    return "audio/aiff";
  }
  if ((extension === ".m4a" || extension === ".mp4") && codec.includes("alac")) {
    return "audio/alac";
  }
  if (extension === ".dsf" || extension === ".dff" || codec.includes("dsd")) {
    return "audio/dsd";
  }
  if (extension === ".ape") {
    return "audio/ape";
  }
  if (extension === ".wv") {
    return "audio/wavpack";
  }

  return "application/octet-stream";
}

function buildSegmentUrls(trackId: string, assetId: string, segmentNames: string[]) {
  return segmentNames.map((segmentName, index) => ({
    segmentName,
    index,
    url: `/api/tracks/${trackId}/segments/${assetId}/${segmentName}`
  }));
}

function computeStreamingSegmentDurationSeconds(input: {
  sampleRate?: number | null;
  channels?: number | null;
}) {
  const sampleRate = Number(input.sampleRate ?? 0);
  const channels = Number(input.channels ?? 0);
  const decodedBytesPerSecond = sampleRate > 0 && channels > 0 ? sampleRate * channels * 4 : 0;

  if (!decodedBytesPerSecond) {
    return DEFAULT_STREAMING_SEGMENT_DURATION_SECONDS;
  }

  const seconds = Math.floor(TARGET_DECODED_CHUNK_BYTES / decodedBytesPerSecond);
  return Math.max(4, Math.min(18, seconds || DEFAULT_STREAMING_SEGMENT_DURATION_SECONDS));
}

function parseXmlAttribute(source: string, attributeName: string) {
  const match = source.match(new RegExp(`${attributeName}="([^"]+)"`));
  return match?.[1] ?? null;
}

function parseIsoDurationMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const match = value.match(/^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.round(((hours * 60 * 60) + (minutes * 60) + seconds) * 1000);
}

export function parseDashSegmentTimeline(mpd: string, segmentNames: string[]) {
  const segmentTemplateMatch = mpd.match(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/);
  if (!segmentTemplateMatch) {
    throw new Error("DASH manifest is missing SegmentTemplate");
  }

  const segmentTemplateAttributes = segmentTemplateMatch[1] ?? "";
  const segmentTimelineBody = segmentTemplateMatch[2] ?? "";
  const timescale = Number(parseXmlAttribute(segmentTemplateAttributes, "timescale") ?? "1");
  if (!Number.isFinite(timescale) || timescale <= 0) {
    throw new Error("DASH manifest has an invalid timescale");
  }

  const segmentMatches = Array.from(segmentTimelineBody.matchAll(/<S\b([^>]*)\/>/g));
  if (!segmentMatches.length) {
    throw new Error("DASH manifest is missing SegmentTimeline entries");
  }

  const timeline = [];
  let currentTicks = 0;

  for (const segmentMatch of segmentMatches) {
    const attributes = segmentMatch[1] ?? "";
    const startTicks = parseXmlAttribute(attributes, "t");
    const durationTicks = Number(parseXmlAttribute(attributes, "d") ?? "0");
    const repeatCount = Number(parseXmlAttribute(attributes, "r") ?? "0");

    if (!Number.isFinite(durationTicks) || durationTicks <= 0) {
      throw new Error("DASH manifest has an invalid segment duration");
    }

    if (!Number.isFinite(repeatCount) || repeatCount < 0) {
      throw new Error("DASH manifest has an unsupported repeat count");
    }

    if (startTicks !== null) {
      currentTicks = Number(startTicks);
    }

    for (let repeatIndex = 0; repeatIndex <= repeatCount; repeatIndex += 1) {
      const segmentStartTicks = currentTicks;
      const segmentEndTicks = currentTicks + durationTicks;
      timeline.push({
        startMs: Math.round((segmentStartTicks / timescale) * 1000),
        endMs: Math.round((segmentEndTicks / timescale) * 1000)
      });
      currentTicks = segmentEndTicks;
    }
  }

  if (timeline.length !== segmentNames.length) {
    throw new Error(
      `DASH manifest segment count mismatch. Timeline=${timeline.length} Files=${segmentNames.length}`
    );
  }

  return {
    durationMs:
      parseIsoDurationMs(parseXmlAttribute(mpd, "mediaPresentationDuration")) ??
      timeline[timeline.length - 1]?.endMs ??
      0,
    segments: timeline.map((segment, index) => ({
      segmentName: segmentNames[index],
      startMs: segment.startMs,
      endMs: segment.endMs
    }))
  };
}

export function buildPlaybackManifest(input: {
  trackId: string;
  assetId: string;
  durationMs: number;
  segmentNames: string[];
  segmentDurationMs?: number;
  timedSegments?: Array<{
    segmentName: string;
    startMs: number;
    endMs: number;
  }>;
}) {
  const segmentNames = input.timedSegments?.map((segment) => segment.segmentName) ?? input.segmentNames;
  const timedSegments = input.timedSegments ?? [];
  const segmentDurationMs = input.segmentDurationMs ?? DEFAULT_STREAMING_SEGMENT_DURATION_MS;
  const segments = buildSegmentUrls(input.trackId, input.assetId, segmentNames).map((segment, index) => {
    const timedSegment = timedSegments[index];
    const startMs = timedSegment?.startMs ?? index * segmentDurationMs;
    const fallbackEndMs = index === segmentNames.length - 1 ? input.durationMs : startMs + segmentDurationMs;
    const endMs = Math.min(input.durationMs, timedSegment?.endMs ?? fallbackEndMs);
    return {
      index,
      startMs,
      endMs,
      url: segment.url
    };
  });

  return {
    version: 1,
    trackId: input.trackId,
    assetId: input.assetId,
    mode: "lossless_chunked",
    chunkMimeType: STREAMING_CHUNK_MIME,
    durationMs: input.durationMs,
    segmentDurationMs: input.segmentDurationMs ?? DEFAULT_STREAMING_SEGMENT_DURATION_MS,
    segments
  } satisfies PlaybackManifest;
}

type TrackRow = {
  id: string;
  sessionId: string;
  originalFilename: string;
  mimeType: string | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  durationMs: number | null;
};

export class MediaService {
  constructor(private readonly database: Database) {}

  private async cleanupObsoleteStreamingAssets(trackId: string, keepAssetId: string) {
    const allAssets = await this.database.select().from(trackAssets).where(eq(trackAssets.trackId, trackId));
    const obsoleteAssets = allAssets.filter(
      (asset: any) => asset.kind === "streaming_playback" && asset.id !== keepAssetId
    );

    if (obsoleteAssets.length === 0) {
      return;
    }

    await this.database
      .delete(trackAssets)
      .where(inArray(trackAssets.id, obsoleteAssets.map((asset: any) => asset.id)));

    await Promise.allSettled(
      obsoleteAssets.map((asset: any) => rm(dirname(asset.storagePath), { recursive: true, force: true }))
    );
  }

  private async assertDecodableAudio(filePath: string) {
    const sink = process.platform === "win32" ? "NUL" : "/dev/null";

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let stderr = "";
      const child = spawn(env.FFMPEG_PATH, ["-v", "error", "-i", filePath, "-f", "null", sink], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
  }

  private async spawnFfmpeg(args: string[], options: { cwd?: string } = {}) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(env.FFMPEG_PATH, args, { stdio: "ignore", cwd: options.cwd });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(`ffmpeg exited with code ${code}`));
      });
    });
  }

  private async queueNormalizeTx(
    tx: any,
    input: {
      sessionId: string;
      trackId: string;
      inputPath: string;
      originalFilename: string;
      codec: string | null;
      sampleRate: number | null;
      bitDepth: number | null;
      channels: number | null;
    }
  ) {
    const assetId = randomUUID();
    const outputPath = join(env.storageRoot, "normalized", input.trackId, `${assetId}.flac`);
    const browserTargets = computeBrowserPlaybackTargets({
      sampleRate: input.sampleRate,
      bitDepth: input.bitDepth,
      extension: extname(input.originalFilename),
      codec: input.codec
    });

    await tx.insert(trackAssets).values({
      id: assetId,
      trackId: input.trackId,
      kind: "normalized_playback",
      status: "pending",
      storagePath: outputPath,
      mimeType: "audio/flac",
      container: "flac",
      codec: "flac",
      sampleRate: browserTargets.sampleRate,
      bitDepth: browserTargets.bitDepth,
      channels: input.channels
    });

    await tx.insert(mediaJobs).values({
      id: randomUUID(),
      sessionId: input.sessionId,
      trackId: input.trackId,
      assetId,
      jobType: "normalize_to_flac",
      status: "pending",
      payload: {
        inputPath: input.inputPath,
        outputPath,
        extension: extname(input.originalFilename).toLowerCase(),
        targetSampleRate: browserTargets.sampleRate,
        targetBitDepth: browserTargets.bitDepth
      }
    });
  }

  private async queueStreamingPackagingTx(
    tx: any,
    input: {
      sessionId: string;
      trackId: string;
      inputPath: string;
      durationMs: number | null;
      sampleRate: number | null;
      bitDepth: number | null;
      channels: number | null;
    }
  ) {
    const assetId = randomUUID();
    const outputDir = join(env.storageRoot, "streaming", input.trackId, assetId);
    const manifestPath = join(outputDir, "manifest.json");
    const targetSampleRate = clampHiFiSampleRate(input.sampleRate);
    const targetBitDepth = clampHiFiBitDepth(input.bitDepth);

    await tx.insert(trackAssets).values({
      id: assetId,
      trackId: input.trackId,
      kind: "streaming_playback",
      status: "pending",
      storagePath: manifestPath,
      mimeType: "application/json",
      container: STREAMING_STORAGE_CONTAINER,
      codec: "pcm",
      sampleRate: targetSampleRate,
      bitDepth: targetBitDepth,
      channels: input.channels
    });

    await tx.insert(mediaJobs).values({
      id: randomUUID(),
      sessionId: input.sessionId,
      trackId: input.trackId,
      assetId,
      jobType: "package_for_segmented_playback",
      status: "pending",
      payload: {
        inputPath: input.inputPath,
        outputDir,
        manifestPath,
        durationMs: input.durationMs,
        segmentDurationSeconds: computeStreamingSegmentDurationSeconds({
          sampleRate: targetSampleRate,
          channels: input.channels
        }),
        sampleRate: targetSampleRate,
        bitDepth: targetBitDepth,
        channels: input.channels
      }
    });
  }

  private async maybeQueueStreamingPackagingTx(
    tx: any,
    input: {
      track: TrackRow;
      assets: Array<any>;
      sourceAsset: { storagePath: string; sampleRate: number | null; bitDepth: number | null; channels: number | null };
    }
  ) {
    const hasStreamingAsset = input.assets.some(
      (asset) =>
        asset.kind === "streaming_playback" &&
        asset.container === STREAMING_STORAGE_CONTAINER &&
        asset.status !== "failed"
    );

    if (hasStreamingAsset) {
      return false;
    }

    await this.queueStreamingPackagingTx(tx, {
      sessionId: input.track.sessionId,
      trackId: input.track.id,
      inputPath: input.sourceAsset.storagePath,
      durationMs: input.track.durationMs,
      sampleRate: input.sourceAsset.sampleRate ?? input.track.sampleRate,
      bitDepth: input.sourceAsset.bitDepth ?? input.track.bitDepth,
      channels: input.sourceAsset.channels ?? input.track.channels
    });

    return true;
  }

  async ensureStorageRoots() {
    await mkdir(join(env.storageRoot, "originals"), { recursive: true });
    await mkdir(join(env.storageRoot, "normalized"), { recursive: true });
    await mkdir(join(env.storageRoot, "streaming"), { recursive: true });
  }

  async handleUpload(
    sessionId: string,
    actor: SessionAccessContext,
    upload: { file: NodeJS.ReadableStream; filename: string; mimetype: string }
  ) {
    await this.ensureStorageRoots();
    const trackId = randomUUID();
    const originalDir = join(env.storageRoot, "originals", trackId);
    await mkdir(originalDir, { recursive: true });

    const safeName = basename(upload.filename);
    const destination = join(originalDir, safeName);
    const writer = createWriteStream(destination);
    const hasher = createHash("sha256");

    upload.file.on("data", (chunk) => hasher.update(chunk));
    await pipeline(upload.file, writer);

    if ((upload.file as NodeJS.ReadableStream & { truncated?: boolean }).truncated) {
      await rm(destination, { force: true });
      const error = new Error("Upload exceeded the server file size limit and was truncated");
      // @ts-expect-error custom status code
      error.statusCode = 413;
      throw error;
    }

    try {
      await this.assertDecodableAudio(destination);
    } catch (error) {
      await rm(destination, { force: true });
      const message = error instanceof Error ? error.message : "Unknown audio decode error";
      const wrappedError = new Error(`Uploaded file could not be decoded cleanly: ${message}`);
      // @ts-expect-error custom status code
      wrappedError.statusCode = 422;
      throw wrappedError;
    }

    const metadata = await parseFile(destination, { duration: true });
    const artwork = pickEmbeddedArtwork(metadata);
    const artworkAssetId = artwork ? randomUUID() : null;
    const artworkPath = artwork && artworkAssetId
      ? join(
          env.storageRoot,
          "artwork",
          trackId,
          `${artworkAssetId}${resolveArtworkFileExtension(artwork.format)}`
        )
      : null;

    if (artwork && artworkPath) {
      await mkdir(dirname(artworkPath), { recursive: true });
      await writeFile(artworkPath, artwork.data);
    }

    const codec = metadata.format.codec ?? null;
    const detectedMime = inferMimeType({
      filename: safeName,
      uploadMimeType: upload.mimetype,
      codec,
      container: metadata.format.container ?? null
    });

    await this.database.transaction(async (tx: any) => {
      await tx.insert(tracks).values({
        id: trackId,
        sessionId,
        uploadedByMemberId: actor.memberId,
        originalFilename: safeName,
        displayTitle: metadata.common.title ?? safeName.replace(extname(safeName), ""),
        artist: metadata.common.artist ?? null,
        album: metadata.common.album ?? null,
        durationMs: metadata.format.duration ? Math.round(metadata.format.duration * 1000) : null,
        mimeType: detectedMime,
        codec,
        sampleRate: metadata.format.sampleRate ?? null,
        bitDepth: metadata.format.bitsPerSample ?? null,
        channels: metadata.format.numberOfChannels ?? null,
        fileHash: hasher.digest("hex")
      });

      await tx.insert(trackAssets).values({
        id: randomUUID(),
        trackId,
        kind: "original",
        status: "complete",
        storagePath: destination,
        mimeType: detectedMime ?? "application/octet-stream",
        container: metadata.format.container ?? null,
        codec,
        sampleRate: metadata.format.sampleRate ?? null,
        bitDepth: metadata.format.bitsPerSample ?? null,
        channels: metadata.format.numberOfChannels ?? null
      });

      if (artwork && artworkAssetId && artworkPath) {
        await tx.insert(trackAssets).values({
          id: artworkAssetId,
          trackId,
          kind: "artwork",
          status: "complete",
          storagePath: artworkPath,
          mimeType: artwork.format,
          container: null,
          codec: null,
          sampleRate: null,
          bitDepth: null,
          channels: null
        });
      }

      const shouldNormalize = needsBrowserPlaybackDerivative({
        extension: extname(safeName),
        codec,
        mimeType: detectedMime,
        container: metadata.format.container ?? null,
        sampleRate: metadata.format.sampleRate ?? null,
        bitDepth: metadata.format.bitsPerSample ?? null
      });

      if (shouldNormalize) {
        await this.queueNormalizeTx(tx, {
          sessionId,
          trackId,
          inputPath: destination,
          originalFilename: safeName,
          codec,
          sampleRate: metadata.format.sampleRate ?? null,
          bitDepth: metadata.format.bitsPerSample ?? null,
          channels: metadata.format.numberOfChannels ?? null
        });
      } else if (
        requiresSegmentedLosslessPlayback({
          extension: extname(safeName),
          codec,
          mimeType: detectedMime,
          container: metadata.format.container ?? null
        })
      ) {
        await this.queueStreamingPackagingTx(tx, {
          sessionId,
          trackId,
          inputPath: destination,
          durationMs: metadata.format.duration ? Math.round(metadata.format.duration * 1000) : null,
          sampleRate: metadata.format.sampleRate ?? null,
          bitDepth: metadata.format.bitsPerSample ?? null,
          channels: metadata.format.numberOfChannels ?? null
        });
      }

      await tx.insert(auditEvents).values({
        id: randomUUID(),
        sessionId,
        memberId: actor.memberId,
        eventType: "track.uploaded",
        payload: { trackId, filename: safeName }
      });
    });

    return { trackId };
  }

  async getTrackAsset(assetId: string) {
    const [asset] = await this.database.select().from(trackAssets).where(eq(trackAssets.id, assetId));
    return asset ?? null;
  }

  async ensureTrackArtworkAsset(trackId: string) {
    const assets = await this.database.select().from(trackAssets).where(eq(trackAssets.trackId, trackId));
    const existingArtwork = assets.find((asset: any) => asset.kind === "artwork");
    if (existingArtwork) {
      return false;
    }

    const sourceAsset = assets.find((asset: any) => asset.kind === "original" && asset.status === "complete");
    if (!sourceAsset) {
      return false;
    }

    try {
      const metadata = await parseFile(sourceAsset.storagePath, { duration: false });
      const artwork = pickEmbeddedArtwork(metadata);
      if (!artwork) {
        return false;
      }

      const artworkAssetId = randomUUID();
      const artworkPath = join(
        env.storageRoot,
        "artwork",
        trackId,
        `${artworkAssetId}${resolveArtworkFileExtension(artwork.format)}`
      );

      await mkdir(dirname(artworkPath), { recursive: true });
      await writeFile(artworkPath, artwork.data);

      await this.database.insert(trackAssets).values({
        id: artworkAssetId,
        trackId,
        kind: "artwork",
        status: "complete",
        storagePath: artworkPath,
        mimeType: artwork.format,
        container: null,
        codec: null,
        sampleRate: null,
        bitDepth: null,
        channels: null
      });

      return true;
    } catch {
      return false;
    }
  }

  async getTrackAssets(trackId: string) {
    return this.database.select().from(trackAssets).where(eq(trackAssets.trackId, trackId));
  }

  async listPendingJobs() {
    return this.database.select().from(mediaJobs).where(eq(mediaJobs.status, "pending")).orderBy(asc(mediaJobs.createdAt));
  }

  async ensureBrowserPlayableAsset(trackId: string) {
    const [track] = await this.database.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) {
      return { queued: false, reason: "track_not_found" };
    }

    const assets = await this.database.select().from(trackAssets).where(eq(trackAssets.trackId, trackId));
    const originalAsset = assets.find((asset: any) => asset.kind === "original");
    if (!originalAsset) {
      return { queued: false, reason: "missing_original_asset" };
    }

    if (
      isMp3Like({
        extension: extname(track.originalFilename),
        codec: track.codec,
        mimeType: track.mimeType,
        container: originalAsset.container
      })
    ) {
      return { queued: false, reason: "direct_file_expected" };
    }

    const shouldNormalize = needsBrowserPlaybackDerivative({
      extension: extname(track.originalFilename),
      codec: track.codec,
      mimeType: track.mimeType,
      container: originalAsset.container,
      sampleRate: track.sampleRate,
      bitDepth: track.bitDepth
    });

    if (shouldNormalize) {
      const normalizedAsset = assets.find(
        (asset: any) => asset.kind === "normalized_playback" && asset.status !== "failed"
      );

      if (!normalizedAsset) {
        await this.database.transaction(async (tx: any) => {
          await this.queueNormalizeTx(tx, {
            sessionId: track.sessionId,
            trackId,
            inputPath: originalAsset.storagePath,
            originalFilename: track.originalFilename,
            codec: track.codec,
            sampleRate: track.sampleRate,
            bitDepth: track.bitDepth,
            channels: track.channels
          });
        });
        return { queued: true, reason: "normalization_enqueued" };
      }

      if (normalizedAsset.status !== "complete") {
        return { queued: false, reason: "normalization_pending" };
      }

      const queued = await this.database.transaction(async (tx: any) =>
        this.maybeQueueStreamingPackagingTx(tx, {
          track,
          assets,
          sourceAsset: normalizedAsset
        })
      );

      return {
        queued,
        reason: queued ? "streaming_enqueued" : "already_exists"
      };
    }

    const queued = await this.database.transaction(async (tx: any) =>
      this.maybeQueueStreamingPackagingTx(tx, {
        track,
        assets,
        sourceAsset: originalAsset
      })
    );

    return {
      queued,
      reason: queued ? "streaming_enqueued" : "already_exists"
    };
  }

  async claimJob(jobId: string) {
    await this.database.update(mediaJobs).set({ status: "processing", updatedAt: new Date() }).where(eq(mediaJobs.id, jobId));
  }

  async completeJob(jobId: string, assetId: string) {
    await this.database.update(mediaJobs).set({ status: "complete", updatedAt: new Date() }).where(eq(mediaJobs.id, jobId));
    await this.database.update(trackAssets).set({ status: "complete", updatedAt: new Date() }).where(eq(trackAssets.id, assetId));
  }

  async failJob(jobId: string, assetId: string | null, error: string) {
    await this.database
      .update(mediaJobs)
      .set({ status: "failed", lastError: error, updatedAt: new Date() })
      .where(eq(mediaJobs.id, jobId));

    if (assetId) {
      await this.database
        .update(trackAssets)
        .set({ status: "failed", errorMessage: error, updatedAt: new Date() })
        .where(eq(trackAssets.id, assetId));
    }
  }

  async processNormalizeJob(job: { id: string; trackId: string; assetId: string | null; payload: unknown }) {
    const payload = job.payload as {
      inputPath: string;
      outputPath: string;
      extension?: string;
      targetSampleRate?: number;
      targetBitDepth?: number;
    };
    const targetDir = join(env.storageRoot, "normalized", job.trackId);
    await mkdir(targetDir, { recursive: true });
    const targetSampleRate = clampHiFiSampleRate(payload.targetSampleRate);
    const targetBitDepth = clampHiFiBitDepth(payload.targetBitDepth);

    const args = ["-y", "-i", payload.inputPath, "-vn", "-c:a", "flac", "-compression_level", "8"];
    if (targetSampleRate) {
      args.push("-ar", String(targetSampleRate));
    }

    const sampleFormat = resolveFfmpegSampleFormat(targetBitDepth);
    if (sampleFormat) {
      args.push("-sample_fmt", sampleFormat);
    }

    const rawBitDepth = resolveFfmpegRawBitDepth(targetBitDepth);
    if (rawBitDepth) {
      args.push("-bits_per_raw_sample", String(rawBitDepth));
    }

    args.push(payload.outputPath);

    await this.spawnFfmpeg(args);

    const normalizedMetadata = await parseFile(payload.outputPath, { duration: true });
    await this.database
      .update(trackAssets)
      .set({
        mimeType: "audio/flac",
        container: normalizedMetadata.format.container ?? "flac",
        codec: normalizedMetadata.format.codec ?? "flac",
        sampleRate: normalizedMetadata.format.sampleRate ?? null,
        bitDepth: normalizedMetadata.format.bitsPerSample ?? null,
        channels: normalizedMetadata.format.numberOfChannels ?? null
      })
      .where(eq(trackAssets.id, job.assetId!));
  }

  async processStreamingPackagingJob(job: { id: string; trackId: string; assetId: string | null; payload: unknown }) {
    const payload = job.payload as {
      inputPath: string;
      outputDir: string;
      manifestPath: string;
      durationMs?: number | null;
      segmentDurationSeconds?: number | null;
      sampleRate?: number | null;
      bitDepth?: number | null;
      channels?: number | null;
    };

    await mkdir(payload.outputDir, { recursive: true });
    const segmentDurationSeconds = Math.max(
      1,
      Math.round(payload.segmentDurationSeconds ?? DEFAULT_STREAMING_SEGMENT_DURATION_SECONDS)
    );
    const targetSampleRate = clampHiFiSampleRate(payload.sampleRate);
    const targetBitDepth = clampHiFiBitDepth(payload.bitDepth);
    const segmentPattern = "seg-%05d.flac";
    const args = [
      "-y",
      "-i",
      payload.inputPath,
      "-map",
      "a:0",
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      "-vn",
    ];

    if (payload.sampleRate) {
      args.push("-ar", String(targetSampleRate ?? payload.sampleRate));
    }

    if (payload.channels) {
      args.push("-ac", String(payload.channels));
    }

    const sampleFormat = resolveFfmpegSampleFormat(targetBitDepth);
    if (sampleFormat) {
      args.push("-sample_fmt", sampleFormat);
    }

    const rawBitDepth = resolveFfmpegRawBitDepth(targetBitDepth);
    if (rawBitDepth) {
      args.push("-bits_per_raw_sample", String(rawBitDepth));
    }

    args.push(
      "-f",
      "segment",
      "-segment_time",
      String(segmentDurationSeconds),
      "-reset_timestamps",
      "1",
      segmentPattern
    );

    await this.spawnFfmpeg(args, {
      cwd: payload.outputDir
    });

    const entries = await readdir(payload.outputDir);
    const segmentNames = entries
      .filter((entry) => entry.endsWith(".flac"))
      .sort((left, right) => left.localeCompare(right));
    if (segmentNames.length === 0) {
      throw new Error("Chunked streaming output is incomplete");
    }

    let nextStartMs = 0;
    const timedSegments = [];
    let outputSampleRate: number | null = null;
    let outputBitDepth: number | null = null;
    let outputChannels: number | null = null;
    for (const segmentName of segmentNames) {
      const segmentPath = join(payload.outputDir, segmentName);
      const chunkMetadata = await parseFile(segmentPath, { duration: true });

      if (outputSampleRate == null) {
        outputSampleRate = chunkMetadata.format.sampleRate ?? targetSampleRate ?? payload.sampleRate ?? null;
      }
      if (outputBitDepth == null) {
        outputBitDepth = chunkMetadata.format.bitsPerSample ?? targetBitDepth ?? payload.bitDepth ?? null;
      }
      if (outputChannels == null) {
        outputChannels = chunkMetadata.format.numberOfChannels ?? payload.channels ?? null;
      }

      const durationMs = chunkMetadata.format.duration
        ? Math.max(1, Math.round(chunkMetadata.format.duration * 1000))
        : segmentDurationSeconds * 1000;
      timedSegments.push({
        segmentName,
        startMs: nextStartMs,
        endMs: nextStartMs + durationMs
      });
      nextStartMs += durationMs;
    }

    const durationMs =
      typeof payload.durationMs === "number" && payload.durationMs > 0
        ? Math.max(payload.durationMs, nextStartMs)
        : nextStartMs;

    const manifest = buildPlaybackManifest({
      trackId: job.trackId,
      assetId: job.assetId!,
      durationMs,
      segmentDurationMs: segmentDurationSeconds * 1000,
      segmentNames,
      timedSegments
    });

    await writeFile(payload.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await this.database
      .update(trackAssets)
      .set({
        mimeType: "application/json",
        container: STREAMING_STORAGE_CONTAINER,
        codec: "flac",
        sampleRate: outputSampleRate,
        bitDepth: outputBitDepth,
        channels: outputChannels
      })
      .where(eq(trackAssets.id, job.assetId!));

    await this.cleanupObsoleteStreamingAssets(job.trackId, job.assetId!);
  }

  async processJob(job: { id: string; trackId: string; assetId: string | null; payload: unknown; jobType: string }) {
    if (job.jobType === "normalize_to_flac") {
      await this.processNormalizeJob(job);
      await this.completeJob(job.id, job.assetId!);
      const streamingResult = await this.ensureBrowserPlayableAsset(job.trackId);
      return {
        message: streamingResult.queued ? "Normalized asset ready. Packaging chunked lossless stream." : "Normalized asset ready"
      };
    }

    if (job.jobType === "package_for_segmented_playback") {
      await this.processStreamingPackagingJob(job);
      await this.completeJob(job.id, job.assetId!);
      return {
        message: "Chunked lossless stream ready"
      };
    }

    throw new Error(`Unsupported media job type: ${job.jobType}`);
  }

  async getPlaybackManifest(assetId: string) {
    const asset = await this.getTrackAsset(assetId);
    if (!asset || asset.kind !== "streaming_playback") {
      return null;
    }

    const raw = await readFile(asset.storagePath, "utf8");
    return JSON.parse(raw) as PlaybackManifest;
  }

  async getPlaybackSegmentPath(assetId: string, segmentName: string) {
    const asset = await this.getTrackAsset(assetId);
    if (!asset || asset.kind !== "streaming_playback") {
      return null;
    }

    if (
      (asset.container === STREAMING_STORAGE_CONTAINER && !/^seg-\d{5}\.flac$/.test(segmentName)) ||
      (asset.container !== STREAMING_STORAGE_CONTAINER && !/^(init\.mp4|seg-\d{5}\.m4s)$/.test(segmentName))
    ) {
      return null;
    }

    return join(dirname(asset.storagePath), segmentName);
  }

  async getStreamStats(storagePath: string) {
    return stat(storagePath);
  }
}
