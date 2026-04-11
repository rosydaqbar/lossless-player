const BUTTON_IDS = {
  previous: "player:previous",
  play: "player:play",
  pause: "player:pause",
  playPause: "player:playpause",
  stop: "player:stop",
  next: "player:next"
};

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function computePositionMs(state) {
  if (!state?.transport) {
    return 0;
  }

  const basePositionMs = Number(state.transport.basePositionMs ?? 0);
  const effectiveAtMs = Number(state.transport.effectiveAtMs ?? 0);

  if (state.transport.status !== "playing") {
    return basePositionMs;
  }

  if (!Number.isFinite(effectiveAtMs) || effectiveAtMs <= 0) {
    return basePositionMs;
  }

  const elapsedMs = Math.max(0, Date.now() - effectiveAtMs);
  return basePositionMs + elapsedMs;
}

function findCurrentTrack(state) {
  if (!state?.queue?.length) {
    return null;
  }

  const byTransport = state.queue.find((item) => item.trackId === state.transport.trackId)?.track;
  if (byTransport) {
    return byTransport;
  }

  const bySelected = state.queue.find((item) => item.isSelected)?.track;
  return bySelected ?? state.queue[0].track;
}

function normalizeNullable(value) {
  return value === null || value === undefined || value === "" ? "unknown" : String(value);
}

function stateSummary(state) {
  const track = findCurrentTrack(state);
  const durationMs = track?.durationMs ?? 0;
  const positionMs = Math.min(computePositionMs(state), durationMs || Number.MAX_SAFE_INTEGER);
  const positionBucketMs = Math.floor(positionMs / 10000) * 10000;
  const artworkAsset = track?.assets?.find((asset) => asset.kind === "artwork" && asset.assetId);

  return {
    transportStatus: state?.transport?.status ?? "idle",
    transportRevision: state?.transport?.revision ?? 0,
    title: track?.displayTitle ?? "No track selected",
    artist: normalizeNullable(track?.artist),
    album: normalizeNullable(track?.album),
    position: formatDuration(positionBucketMs),
    duration: formatDuration(durationMs),
    positionMs: positionBucketMs,
    durationMs,
    codec: normalizeNullable(track?.codec),
    mimeType: normalizeNullable(track?.mimeType),
    sampleRate: track?.sampleRate ? `${track.sampleRate} Hz` : "unknown",
    bitDepth: track?.bitDepth ? `${track.bitDepth}-bit` : "unknown",
    channels: normalizeNullable(track?.channels),
    playbackMode: track?.playbackReady ? "ready" : normalizeNullable(track?.pendingJobStatus),
    trackId: track?.trackId ?? "",
    artworkAssetId: artworkAsset?.assetId ?? "",
    sessionId: state?.sessionId ?? "",
    sessionName: state?.sessionName ?? "",
    queueLength: state?.queue?.length ?? 0,
    currentRole: state?.currentMember?.role ?? "listener"
  };
}

function buildProgressBar(positionMs, durationMs) {
  if (!durationMs || durationMs <= 0) {
    return "░░░░░░░░░░░░";
  }

  const segments = 12;
  const ratio = Math.max(0, Math.min(1, positionMs / durationMs));
  const active = Math.round(ratio * segments);
  return `${"█".repeat(active)}${"░".repeat(Math.max(0, segments - active))}`;
}

function getStatusBadge(status) {
  if (status === "playing") {
    return "🟢 Playing";
  }
  if (status === "paused") {
    return "🟡 Paused";
  }
  return "⚪ Idle";
}

function buildHeaderBlock(summary) {
  const albumText = summary.album === "unknown" ? "Single" : summary.album;
  return [
    `-# ${summary.sessionName || "Shared Listening Room"}`,
    `**${summary.title}**`,
    `${summary.artist} • ${albumText}`
  ].join("\n");
}

function buildTransportBlock(summary) {
  const progressBar = buildProgressBar(summary.positionMs, summary.durationMs);
  return `${getStatusBadge(summary.transportStatus)} • Queue ${summary.queueLength}\n${progressBar} ${summary.position} / ${summary.duration}`;
}

function buildMetaBlock(summary) {
  return `-# ${summary.codec} • ${summary.sampleRate} • ${summary.bitDepth} • ${summary.channels}ch • ${summary.mimeType}`;
}

function encodeUploadLink(baseUrl, state, connection) {
  const params = new URLSearchParams({
    upload: "1",
    sessionId: state.sessionId
  });

  if (connection.sessionAccessCode) {
    params.set("accessCode", connection.sessionAccessCode);
  }

  return `${baseUrl}/?${params.toString()}`;
}

export function getMessageHash(state) {
  return JSON.stringify(stateSummary(state));
}

export function getPlayPauseAction(state) {
  return state?.transport?.status === "playing" ? "pause" : "play";
}

export function getButtonIds() {
  return { ...BUTTON_IDS };
}

export function buildStatusMessagePayload(state, config, connection, options = {}) {
  const summary = stateSummary(state);
  const playPauseLabel = getPlayPauseAction(state) === "pause" ? "Pause" : "Play";
  const canStepQueue = summary.queueLength > 1;
  const canControl = true;
  const isPlaying = summary.transportStatus === "playing";
  const artworkAttachmentName = options.artworkAttachmentName ?? "";
  const artworkAccessory = artworkAttachmentName
    ? {
        type: 11,
        media: {
          url: `attachment://${artworkAttachmentName}`
        },
        spoiler: false
      }
    : undefined;
  const openPlayerUrl = `${config.playerWebBaseUrl}/`;
  const addMusicUrl = encodeUploadLink(config.playerWebBaseUrl, state, connection);
  const metaLine = buildMetaBlock(summary);
  const headerComponent = artworkAccessory
    ? {
        type: 9,
        components: [
          {
            type: 10,
            content: buildHeaderBlock(summary)
          }
        ],
        accessory: artworkAccessory
      }
    : {
        type: 10,
        content: buildHeaderBlock(summary)
      };

  return {
    content: "",
    flags: 1 << 15,
    components: [
      {
        type: 17,
        accent_color: isPlaying ? 5763719 : 9807270,
        components: [
          headerComponent,
          {
            type: 10,
            content: buildTransportBlock(summary)
          },
          {
            type: 10,
            content: metaLine
          },
          {
            type: 14,
            divider: true,
            spacing: 1
          },
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 2,
                label: "⏮️ Previous",
                custom_id: BUTTON_IDS.previous,
                disabled: !canControl || !canStepQueue
              },
              {
                type: 2,
                style: playPauseLabel === "Play" ? 3 : 1,
                label: playPauseLabel === "Play" ? "▶️ Play" : "⏸️ Pause",
                custom_id: playPauseLabel === "Play" ? BUTTON_IDS.play : BUTTON_IDS.pause,
                disabled: !canControl
              },
              {
                type: 2,
                style: 4,
                label: "⏹️ Stop",
                custom_id: BUTTON_IDS.stop,
                disabled: !canControl
              },
              {
                type: 2,
                style: 2,
                label: "Next ⏭️",
                custom_id: BUTTON_IDS.next,
                disabled: !canControl || !canStepQueue
              }
            ]
          }
        ]
      },
      {
        type: 10,
        content: "To listen or add new music to queue:"
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open Player",
            url: openPlayerUrl
          },
          {
            type: 2,
            style: 5,
            label: "Add Music",
            url: addMusicUrl
          }
        ]
      }
    ]
  };
}
