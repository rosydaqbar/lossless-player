import type { ClientCapabilities } from "@lossless-player/contracts";

export function computeCurrentPositionMs(
  transport: { status: string; basePositionMs: number; effectiveAtMs: number },
  serverTimeMs: number
) {
  if (transport.status !== "playing") {
    return transport.basePositionMs;
  }

  return Math.max(0, transport.basePositionMs + Math.max(0, serverTimeMs - transport.effectiveAtMs));
}

export function canManagePlayback(role: string) {
  return role === "owner" || role === "controller";
}

export function isMp3Like(input: {
  extension?: string | null | undefined;
  codec?: string | null | undefined;
  mimeType?: string | null | undefined;
  container?: string | null | undefined;
}) {
  const extension = input.extension?.toLowerCase() ?? "";
  const codec = input.codec?.toLowerCase() ?? "";
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  const container = input.container?.toLowerCase() ?? "";

  return (
    extension === ".mp3" ||
    mimeType === "audio/mpeg" ||
    codec.includes("mpeg") ||
    codec.includes("mp3") ||
    container.includes("mpeg")
  );
}

export function requiresNormalization(input: {
  extension: string;
  codec: string | null | undefined;
  mimeType: string | null | undefined;
  container?: string | null | undefined;
}) {
  const extension = input.extension.toLowerCase();
  const codec = input.codec?.toLowerCase() ?? "";
  const mimeType = input.mimeType?.toLowerCase() ?? "";
  const container = input.container?.toLowerCase() ?? "";
  const directPlayExtension = [".mp3", ".flac", ".wav", ".wave", ".aiff", ".aif"].includes(extension);
  const directPlayCodec =
    codec.includes("flac") ||
    codec.includes("mpeg") ||
    codec.includes("mp3") ||
    codec.includes("pcm") ||
    codec.includes("aiff");
  const directPlayContainer =
    container.includes("flac") ||
    container.includes("wave") ||
    container.includes("wav") ||
    container.includes("aiff");

  if ([".dsf", ".dff", ".ape", ".wv", ".alac"].includes(extension)) {
    return true;
  }

  if (extension === ".m4a" || extension === ".mp4") {
    return true;
  }

  if (codec.includes("alac") || codec.includes("dsd")) {
    return true;
  }

  if (mimeType.includes("audio/mp4") && codec.includes("alac")) {
    return true;
  }

  if (container.includes("dsf") || container.includes("dff") || container.includes("ape")) {
    return true;
  }

  if (directPlayExtension || isDirectPlayMime(mimeType) || directPlayCodec || directPlayContainer) {
    return false;
  }

  if (extension) {
    return true;
  }

  return false;
}

export function needsBrowserPlaybackDerivative(input: {
  extension?: string | null | undefined;
  codec: string | null | undefined;
  mimeType: string | null | undefined;
  container?: string | null | undefined;
  sampleRate?: number | null | undefined;
  bitDepth?: number | null | undefined;
}) {
  return requiresNormalization({
    extension: input.extension ?? "",
    codec: input.codec,
    mimeType: input.mimeType,
    container: input.container
  });
}

export function requiresSegmentedLosslessPlayback(input: {
  extension?: string | null | undefined;
  codec?: string | null | undefined;
  mimeType?: string | null | undefined;
  container?: string | null | undefined;
}) {
  return !isMp3Like(input);
}

export function isDirectPlayMime(mimeType: string | null | undefined) {
  return [
    "audio/mpeg",
    "audio/flac",
    "audio/x-flac",
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/vnd.wave",
    "audio/x-aiff",
    "audio/aiff"
  ].includes((mimeType ?? "").toLowerCase());
}

export function supportsSegmentedLosslessPlayback(capabilities: ClientCapabilities) {
  return capabilities.supportsFlac || capabilities.supportsMseFlacSegmented;
}

function isPlayableOriginalAsset(
  asset: {
    mimeType: string;
    container?: string | null;
    codec?: string | null;
  },
  capabilities: ClientCapabilities
) {
  const mimeType = (asset.mimeType ?? "").toLowerCase();
  const container = (asset.container ?? "").toLowerCase();
  const codec = (asset.codec ?? "").toLowerCase();

  if (
    capabilities.supportsFlac &&
    (mimeType === "audio/flac" ||
      mimeType === "audio/x-flac" ||
      container.includes("flac") ||
      codec.includes("flac"))
  ) {
    return true;
  }

  if (
    capabilities.supportsMp3 &&
    (mimeType === "audio/mpeg" || codec.includes("mpeg") || codec.includes("mp3"))
  ) {
    return true;
  }

  if (
    capabilities.supportsWav &&
    (mimeType === "audio/wav" ||
      mimeType === "audio/wave" ||
      mimeType === "audio/x-wav" ||
      mimeType === "audio/vnd.wave" ||
      container.includes("wave") ||
      container.includes("wav") ||
      codec.includes("pcm"))
  ) {
    return true;
  }

  if (
    capabilities.supportsAiff &&
    (mimeType === "audio/aiff" ||
      mimeType === "audio/x-aiff" ||
      container.includes("aiff") ||
      codec.includes("aiff"))
  ) {
    return true;
  }

  return false;
}

function isPlayableDirectAsset(
  asset: {
    mimeType: string;
    container?: string | null;
    codec?: string | null;
  },
  capabilities: ClientCapabilities
) {
  return isPlayableOriginalAsset(asset, capabilities);
}

export function pickBestAsset(
  input: {
    track: {
      extension?: string | null;
      mimeType?: string | null;
      codec?: string | null;
      container?: string | null;
    };
    assets: Array<{
      assetId: string;
      kind: string;
      status?: string;
      mimeType: string;
      container?: string | null;
      codec?: string | null;
      sampleRate?: number | null;
      bitDepth?: number | null;
    }>;
    capabilities: ClientCapabilities;
  }
) {
  const { track, assets, capabilities } = input;
  const available = assets.filter((asset) => !asset.status || asset.status === "complete");
  const wantsSegmentedLossless = requiresSegmentedLosslessPlayback(track);

  const directPlayable = available.find(
    (asset) =>
      (asset.kind === "original" || asset.kind === "normalized_playback") &&
      isPlayableDirectAsset(asset, capabilities)
  );

  if (directPlayable) {
    return {
      mode: "direct_file" as const,
      asset: directPlayable
    };
  }

  if (wantsSegmentedLossless) {
    if (!supportsSegmentedLosslessPlayback(capabilities)) {
      return {
        mode: "unsupported" as const,
        reason: "Chunked lossless playback requires Chromium or Edge on this device."
      };
    }

    const streamingPlayback = available.find(
      (asset) =>
        asset.kind === "streaming_playback" &&
        asset.container?.toLowerCase() === "flac_chunks"
    );
    return streamingPlayback
      ? {
          mode: "lossless_chunked" as const,
          asset: streamingPlayback
        }
      : null;
  }

  return null;
}
