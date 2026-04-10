import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Slider from "@radix-ui/react-slider";
import * as Tabs from "@radix-ui/react-tabs";
import * as Toast from "@radix-ui/react-toast";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  controlPlayback,
  deleteSession,
  fetchSessionState,
  getApiUrl,
  mutateQueue,
  resolveTrackAsset,
  updateMemberRole,
  uploadTracks
} from "../lib/api.js";
import { playbackService } from "../lib/playback-service.js";
import { createSessionSocket } from "../lib/socket.js";
import { useSessionStore } from "../store/session-store.js";

function formatDuration(durationMs) {
  if (!durationMs) {
    return "0:00";
  }
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatTrackFacts(track) {
  if (!track) {
    return "Upload a track or select one from the queue.";
  }

  return [
    track.artist,
    track.album,
    track.sampleRate && `${track.sampleRate} Hz`,
    track.bitDepth && `${track.bitDepth}-bit`,
    track.codec
  ]
    .filter(Boolean)
    .join(" - ");
}

function formatTransportStatus(status) {
  if (status === "playing") {
    return "Playing";
  }

  if (status === "paused") {
    return "Paused";
  }

  return "Stopped";
}

function ControlIcon({ children, className = "h-5 w-5" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

function RewindIcon() {
  return (
    <ControlIcon>
      <path d="M11 7L6 12l5 5" />
      <path d="M18 7l-5 5 5 5" />
    </ControlIcon>
  );
}

function PreviousIcon() {
  return (
    <ControlIcon>
      <path d="M7 6v12" />
      <path d="M18 7l-7 5 7 5V7z" />
    </ControlIcon>
  );
}

function PlayIcon() {
  return (
    <ControlIcon>
      <path d="M8 6.5v11l9-5.5-9-5.5z" />
    </ControlIcon>
  );
}

function PauseIcon() {
  return (
    <ControlIcon>
      <path d="M9 6v12" />
      <path d="M15 6v12" />
    </ControlIcon>
  );
}

function StopIcon() {
  return (
    <ControlIcon>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </ControlIcon>
  );
}

function NextIcon() {
  return (
    <ControlIcon>
      <path d="M17 6v12" />
      <path d="M6 7l7 5-7 5V7z" />
    </ControlIcon>
  );
}

function ForwardIcon() {
  return (
    <ControlIcon>
      <path d="M6 7l5 5-5 5" />
      <path d="M13 7l5 5-5 5" />
    </ControlIcon>
  );
}

function VolumeIcon({ muted = false }) {
  return (
    <ControlIcon>
      <path d="M5 10h3l4-4v12l-4-4H5z" />
      {muted ? <path d="M16 9l4 6M20 9l-4 6" /> : <path d="M16 9.5a4.5 4.5 0 010 5" />}
    </ControlIcon>
  );
}

function UploadIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <path d="M12 16V6" />
      <path d="M8.5 9.5L12 6l3.5 3.5" />
      <path d="M5 18h14" />
    </ControlIcon>
  );
}

function TrashIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M8 10v7" />
      <path d="M12 10v7" />
      <path d="M16 10v7" />
    </ControlIcon>
  );
}

function MinimizeIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <path d="M7 10l5 5 5-5" />
    </ControlIcon>
  );
}

function ExpandIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <path d="M7 14l5-5 5 5" />
    </ControlIcon>
  );
}

function CloseIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <path d="M8 8l8 8" />
      <path d="M16 8l-8 8" />
    </ControlIcon>
  );
}

function formatQueueMeta(track) {
  return [track.artist, track.album].filter(Boolean).join(" - ") || "Unknown metadata";
}

function toAbsoluteApiUrl(path) {
  if (!path) {
    return path;
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${getApiUrl()}${path}`;
}

function resolvePlaybackDescriptorUrls(descriptor) {
  if (!descriptor) {
    return descriptor;
  }

  if (descriptor.mode === "mse_segmented" || descriptor.mode === "lossless_chunked") {
    return {
      ...descriptor,
      manifestUrl: toAbsoluteApiUrl(descriptor.manifestUrl)
    };
  }

  return {
    ...descriptor,
    streamUrl: toAbsoluteApiUrl(descriptor.streamUrl)
  };
}

export function SessionRoom() {
  const queryClient = useQueryClient();
  const sessionId = useSessionStore((state) => state.sessionId);
  const accessToken = useSessionStore((state) => state.accessToken);
  const audioArmed = useSessionStore((state) => state.audioArmed);
  const setAudioArmed = useSessionStore((state) => state.setAudioArmed);
  const clearSession = useSessionStore((state) => state.clearSession);
  const activeTransportTrackIdRef = useRef(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isPlayerMinimized, setIsPlayerMinimized] = useState(false);
  const fileInputRef = useRef(null);
  const [toast, setToast] = useState({ open: false, title: "", description: "" });
  const [playbackView, setPlaybackView] = useState({
    currentTimeMs: 0,
    paused: true,
    durationMs: 0,
    volume: 0.15,
    muted: false,
    errorMessage: null,
    endedCount: 0
  });
  const lastPlaybackErrorRef = useRef(null);
  const lastHandledEndedCountRef = useRef(0);

  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSessionState(sessionId, accessToken),
    enabled: Boolean(sessionId && accessToken)
  });

  const state = sessionQuery.data;
  const sessionLoadErrorMessage = sessionQuery.error?.message?.toLowerCase?.() ?? "";
  const shouldReturnToHome = sessionQuery.isError;
  const currentTrack = useMemo(() => {
    if (!state) {
      return null;
    }

    const transportTrack = state.queue.find((item) => item.trackId === state.transport.trackId)?.track;
    if (transportTrack) {
      return transportTrack;
    }

    const selectedTrack = state.queue.find((item) => item.isSelected)?.track;
    return selectedTrack ?? state.queue[0]?.track ?? null;
  }, [state]);
  const isController = state?.currentMember?.role === "owner" || state?.currentMember?.role === "controller";
  const trackDurationMs = currentTrack?.durationMs ?? playbackView.durationMs ?? 0;
  const displayPositionMs = trackDurationMs
    ? Math.min(playbackView.currentTimeMs, trackDurationMs)
    : playbackView.currentTimeMs;
  const volumePercent = Math.round((playbackView.muted ? 0 : playbackView.volume) * 100);
  const playbackPending = Boolean(currentTrack && !currentTrack.playbackReady);
  const selectedQueueIndex = useMemo(() => {
    if (!state?.queue?.length) {
      return -1;
    }

    const explicitSelectedIndex = state.queue.findIndex((item) => item.isSelected);
    if (explicitSelectedIndex >= 0) {
      return explicitSelectedIndex;
    }

    return state.queue.findIndex((item) => item.trackId === state.transport.trackId);
  }, [state]);
  useEffect(() => {
    activeTransportTrackIdRef.current = state?.transport?.trackId ?? null;
  }, [state?.transport?.trackId]);

  useEffect(() => {
    if (!sessionQuery.isError) {
      return;
    }

    playbackService.clearSource();
    clearSession(
      sessionLoadErrorMessage.includes("failed to fetch")
        ? "Connection lost. Join or create a room again."
        : sessionQuery.error?.message ?? ""
    );
  }, [clearSession, sessionLoadErrorMessage, sessionQuery.error, sessionQuery.isError]);

  useEffect(() => playbackService.subscribe(setPlaybackView), []);

  useEffect(() => {
    if (!sessionId || !accessToken) {
      return undefined;
    }

    const socket = createSessionSocket();
    socket.on("connect", () => {
      socket.emit("session:join", { sessionId, accessToken });
    });
    socket.on("session:state", (nextState) => {
      queryClient.setQueryData(["session", sessionId], nextState);
    });
    socket.on("transport:command", (command) => {
      queryClient.setQueryData(["session", sessionId], (current) =>
        current
          ? {
              ...current,
              transport: {
                ...current.transport,
                trackId: command.trackId,
                status: command.status,
                basePositionMs: command.positionMs,
                effectiveAtMs: command.effectiveAtMs,
                revision: command.revision,
                updatedByMemberId: command.issuedByMemberId
              },
              serverTimeMs: command.serverTimeMs
            }
          : current
      );
    });
    socket.on("upload:status", (event) => {
      setToast({
        open: true,
        title: "Upload update",
        description: event.message
      });
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    });
    socket.on("session:error", (event) => {
      if (event?.code === "track_deleted") {
        if (event.trackId && event.trackId === activeTransportTrackIdRef.current) {
          playbackService.clearSource();
        }
        queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }

      if (event?.code === "session_deleted") {
        playbackService.clearSource();
        clearSession(event.message ?? "Session deleted.");
        return;
      }

      setToast({
        open: true,
        title: "Socket error",
        description: event.message
      });
    });

    return () => {
      socket.close();
    };
  }, [accessToken, clearSession, queryClient, sessionId]);

  useEffect(() => {
    let cancelled = false;
    async function syncPlayback() {
      if (!audioArmed || !state?.transport) {
        return;
      }

      if (!state.transport.trackId) {
        playbackService.syncTransport(state.transport, state.serverTimeMs);
        return;
      }

      const activeTrack = state.queue.find((item) => item.trackId === state.transport.trackId)?.track ?? null;
      if (!activeTrack?.playbackReady) {
        return;
      }

      const asset = await resolveTrackAsset(
        sessionId,
        state.transport.trackId,
        accessToken,
        playbackService.getCapabilities()
      );

      if (cancelled) {
        return;
      }

      const descriptor = resolvePlaybackDescriptorUrls(asset);
      await playbackService.loadPlaybackDescriptor(descriptor);
      playbackService.syncTransport(state.transport, state.serverTimeMs);
    }

    syncPlayback().catch((error) => {
      setToast({
        open: true,
        title: "Playback error",
        description: error.message
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    accessToken,
    audioArmed,
    currentTrack?.trackId,
    currentTrack?.playbackReady,
    sessionId,
    state?.transport?.trackId,
    state?.transport?.status,
    state?.transport?.basePositionMs,
    state?.transport?.effectiveAtMs,
    state?.transport?.revision
  ]);

  useEffect(() => {
    playbackService.clearPrewarm();
  }, [state?.transport?.trackId, state?.transport?.status]);

  const queueMutation = useMutation({
    mutationFn: (input) => mutateQueue(sessionId, accessToken, input),
    onSuccess(nextState) {
      queryClient.setQueryData(["session", sessionId], nextState);
    },
    onError(error) {
      setToast({ open: true, title: "Queue error", description: error.message });
    }
  });

  const controlMutation = useMutation({
    mutationFn: (input) => controlPlayback(sessionId, accessToken, input),
    onSuccess(payload) {
      queryClient.setQueryData(["session", sessionId], payload.state);
    },
    onError(error) {
      setToast({ open: true, title: "Transport error", description: error.message });
    }
  });

  const roleMutation = useMutation({
    mutationFn: ({ memberId, role }) => updateMemberRole(sessionId, memberId, accessToken, { role }),
    onSuccess(nextState) {
      queryClient.setQueryData(["session", sessionId], nextState);
    },
    onError(error) {
      setToast({ open: true, title: "Role update failed", description: error.message });
    }
  });

  const uploadMutation = useMutation({
    mutationFn: (files) => uploadTracks(sessionId, accessToken, files),
    onSuccess() {
      setUploadOpen(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setSelectedFiles([]);
      queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    onError(error) {
      setToast({ open: true, title: "Upload failed", description: error.message });
    }
  });

  const abandonMutation = useMutation({
    mutationFn: () => deleteSession(sessionId, accessToken),
    onSuccess() {
      playbackService.clearSource();
      clearSession("Session abandoned.");
    },
    onError(error) {
      setToast({ open: true, title: "Room deletion failed", description: error.message });
    }
  });

  function clearSelectedFiles() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setSelectedFiles([]);
  }

  function mergeSelectedFiles(nextFiles) {
    setSelectedFiles((currentFiles) => {
      const merged = [...currentFiles];

      for (const file of nextFiles) {
        const exists = merged.some(
          (currentFile) =>
            currentFile.name === file.name &&
            currentFile.size === file.size &&
            currentFile.lastModified === file.lastModified
        );

        if (!exists) {
          merged.push(file);
        }
      }

      return merged;
    });
  }

  function handleFileSelection(event) {
    const nextFiles = Array.from(event.target.files ?? []);
    if (nextFiles.length) {
      mergeSelectedFiles(nextFiles);
    }

    event.target.value = "";
  }

  function removeSelectedFile(targetFile) {
    setSelectedFiles((currentFiles) =>
      currentFiles.filter(
        (file) =>
          !(
            file.name === targetFile.name &&
            file.size === targetFile.size &&
            file.lastModified === targetFile.lastModified
          )
      )
    );
  }

  useEffect(() => {
    if (!playbackView.errorMessage || playbackView.errorMessage === lastPlaybackErrorRef.current) {
      return;
    }

    lastPlaybackErrorRef.current = playbackView.errorMessage;
    setToast({
      open: true,
      title: "Playback blocked",
      description: playbackView.errorMessage
    });
  }, [playbackView.errorMessage]);

  useEffect(() => {
    if (playbackView.endedCount === 0 || playbackView.endedCount === lastHandledEndedCountRef.current) {
      return;
    }

    lastHandledEndedCountRef.current = playbackView.endedCount;

    if (!isController || !state?.transport?.trackId || state.transport.status !== "playing") {
      return;
    }

    const transportQueueIndex = state.queue.findIndex((item) => item.trackId === state.transport.trackId);
    const selectedQueueIndex = state.queue.findIndex((item) => item.isSelected);
    const currentQueueIndex = transportQueueIndex >= 0 ? transportQueueIndex : selectedQueueIndex;
    const hasNextTrack = currentQueueIndex >= 0 && currentQueueIndex < state.queue.length - 1;

    controlMutation.mutate({
      action: hasNextTrack ? "next" : "stop",
      revision: state.transport.revision
    });
  }, [controlMutation, isController, playbackView.endedCount, state?.queue, state?.transport]);

  async function ensureLocalAudioReady() {
    if (audioArmed) {
      return;
    }

    await playbackService.arm();
    setAudioArmed(true);
  }

  function handleAudioToggle() {
    if (audioArmed) {
      playbackService.deactivate();
      setAudioArmed(false);
      return;
    }

    ensureLocalAudioReady().catch((error) => {
      setToast({
        open: true,
        title: "Playback blocked",
        description: error instanceof Error ? error.message : "The browser blocked audio playback."
      });
    });
  }

  async function handlePlayPause() {
    if (!currentTrack) {
      return;
    }

    if (playbackPending) {
      setToast({
        open: true,
        title: "Preparing playback",
        description:
          currentTrack.pendingJobStatus === "failed"
            ? "This track could not be prepared for browser playback."
            : "This lossless file is still being prepared for browser playback."
      });
      return;
    }

    if (state.transport.status === "playing") {
      controlMutation.mutate({
        action: "pause",
        revision: state.transport.revision,
        positionMs: playbackView.currentTimeMs
      });
      return;
    }

    try {
      await ensureLocalAudioReady();
    } catch (error) {
      setToast({
        open: true,
        title: "Playback blocked",
        description: error instanceof Error ? error.message : "The browser blocked audio playback."
      });
      return;
    }

    controlMutation.mutate({ action: "play", revision: state.transport.revision });
  }

  function handleSeek(positionMs) {
    if (!isController || !currentTrack || playbackPending || controlMutation.isPending) {
      return;
    }

    controlMutation.mutate({
      action: "seek",
      revision: state.transport.revision,
      positionMs
    });
  }

  function handleJump(deltaMs) {
    if (!currentTrack) {
      return;
    }

    handleSeek(clamp(displayPositionMs + deltaMs, 0, trackDurationMs || displayPositionMs + deltaMs));
  }

  async function handleQueueSelect(queueItemId) {
    if (!isController || queueMutation.isPending) {
      return;
    }

    try {
      await queueMutation.mutateAsync({ type: "select", queueItemId });
    } catch {
      // Error toast is handled by the mutation itself.
    }
  }

  async function handleQueuePlay(item) {
    if (!isController || queueMutation.isPending || controlMutation.isPending) {
      return;
    }

    if (!item.track.playbackReady) {
      setToast({
        open: true,
        title: "Preparing playback",
        description:
          item.track.pendingJobStatus === "failed"
            ? "This track could not be prepared for browser playback."
            : "This lossless file is still being prepared for browser playback."
      });
      return;
    }

    try {
      await ensureLocalAudioReady();
      const nextState = await queueMutation.mutateAsync({
        type: "select",
        queueItemId: item.queueItemId
      });
      await controlMutation.mutateAsync({
        action: "play",
        revision: nextState.transport.revision
      });
    } catch (error) {
      if (error instanceof Error) {
        setToast({
          open: true,
          title: "Playback error",
          description: error.message
        });
      }
    }
  }

  function handleAbandonRoom() {
    if (abandonMutation.isPending) {
      return;
    }

    if (!window.confirm("Abandone this room and delete all uploaded music?")) {
      return;
    }

    abandonMutation.mutate();
  }

  if (sessionQuery.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-zinc-300">Loading session...</div>;
  }

  if (shouldReturnToHome) {
    return null;
  }

  if (!state) {
    return null;
  }

  return (
    <Toast.Provider swipeDirection="right">
      <Tooltip.Provider delayDuration={120}>
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 pb-44 pt-8">
          <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 shadow-2xl shadow-black/30 backdrop-blur sm:p-8">
            <div className="flex flex-col gap-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-3">
                  <div className="text-xs uppercase tracking-[0.3em] text-sky-200">Live room</div>
                  <h1 className="text-4xl font-semibold text-white">{state.sessionName}</h1>
                </div>
                <button
                  className="shrink-0 self-start rounded-2xl border border-rose-300/25 bg-rose-400/[0.08] px-4 py-3 text-sm font-medium text-rose-100 transition hover:bg-rose-400/[0.14] disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={abandonMutation.isPending}
                  onClick={handleAbandonRoom}
                >
                  {abandonMutation.isPending ? "Abandoning..." : "Abandone Room"}
                </button>
              </div>

              <div className="flex flex-wrap gap-2 text-sm text-zinc-300">
                <span className="rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-sky-100">
                  Role {state.currentMember.role}
                </span>
                <span className="rounded-full border border-white/10 px-3 py-1">Session {state.sessionId}</span>
                {state.listenerCode ? (
                  <span className="rounded-full border border-white/10 px-3 py-1">Listener code {state.listenerCode}</span>
                ) : null}
                {state.controllerCode ? (
                  <span className="rounded-full border border-white/10 px-3 py-1">Controller code {state.controllerCode}</span>
                ) : null}
                {playbackPending ? (
                  <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-amber-200">
                    {currentTrack?.pendingJobStatus === "failed" ? "Playback prep failed" : "Preparing playback"}
                  </span>
                ) : null}
              </div>

              <div
                className={`audio-banner flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm ${
                  audioArmed
                    ? "audio-banner-active border-emerald-300/20 bg-emerald-400/[0.08] text-emerald-50"
                    : "audio-banner-inactive border-white/10 bg-white/[0.04] text-zinc-300"
                }`}
              >
                <span className="min-w-0 font-medium text-white">
                  {audioArmed
                    ? "Audio is active on this device for shared playback."
                    : "Activate audio on this device to hear the room."}
                </span>
                <button
                  className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${
                    audioArmed
                      ? "border border-white/10 bg-white/8 text-white hover:bg-white/12"
                      : "border border-white/10 bg-white/6 text-white hover:bg-white/10"
                  }`}
                  onClick={handleAudioToggle}
                >
                  {audioArmed ? "Deactivate Audio" : "Activate Audio"}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
              <Tabs.Root defaultValue="queue" className="space-y-4">
                <Tabs.List className="grid grid-cols-2 rounded-2xl border border-white/10 bg-white/5 p-1">
                  <Tabs.Trigger
                    value="queue"
                    className="rounded-xl px-4 py-3 text-sm text-zinc-300 data-[state=active]:bg-white data-[state=active]:text-zinc-950"
                  >
                    Queue
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="members"
                    className="rounded-xl px-4 py-3 text-sm text-zinc-300 data-[state=active]:bg-white data-[state=active]:text-zinc-950"
                  >
                    Members
                  </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="queue">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.25em] text-zinc-500">Tracks</div>
                      <div className="mt-1 text-sm text-zinc-300">
                        {state.queue.length} track{state.queue.length === 1 ? "" : "s"} in this room
                      </div>
                    </div>
                    <Dialog.Root open={uploadOpen} onOpenChange={setUploadOpen}>
                      <Dialog.Trigger asChild>
                        <button className="inline-flex items-center gap-2 rounded-2xl bg-sky-400 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-sky-300">
                          <UploadIcon />
                          Upload track
                        </button>
                      </Dialog.Trigger>
                      <Dialog.Portal>
                        <Dialog.Overlay className="upload-modal-overlay fixed inset-0 bg-black/60" />
                        <Dialog.Content className="fixed inset-0 flex items-center justify-center p-4 outline-none">
                          <div className="upload-modal-content pointer-events-auto flex max-h-[70vh] w-[90vw] max-w-lg flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-zinc-950 p-6">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <Dialog.Title className="text-xl font-semibold text-white">Add tracks to this room</Dialog.Title>
                                <Dialog.Description className="mt-2 text-sm text-zinc-400">
                                  Files are stored on the server for this room so everyone hears the same queue.
                                </Dialog.Description>
                              </div>
                              <Dialog.Close asChild>
                                <button
                                  aria-label="Close upload dialog"
                                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
                                >
                                  <CloseIcon />
                                </button>
                              </Dialog.Close>
                            </div>
                            <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
                              <input
                                ref={fileInputRef}
                                multiple
                                type="file"
                                accept=".mp3,.flac,.wav,.aiff,.aif,.m4a,.alac,.dsf,.dff,.ape,.wv"
                                className="hidden"
                                onChange={handleFileSelection}
                              />
                              <button
                                className="w-full rounded-2xl border border-dashed border-white/20 bg-white/5 px-4 py-4 text-sm text-white hover:bg-white/10"
                                onClick={() => fileInputRef.current?.click()}
                              >
                                {selectedFiles.length ? "Add more files" : "Browse files"}
                              </button>
                              <input
                                readOnly
                                value={selectedFiles.length ? selectedFiles.map((file) => file.name).join(", ") : ""}
                                placeholder="No files selected yet"
                                className="block w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-200"
                              />
                              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-300">
                                <div className="flex items-center justify-between gap-3">
                                  <span>{selectedFiles.length ? `${selectedFiles.length} file(s) selected` : "No files selected yet"}</span>
                                  {selectedFiles.length ? (
                                    <button
                                      className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white hover:bg-white/5"
                                      onClick={clearSelectedFiles}
                                    >
                                      Clear
                                    </button>
                                  ) : null}
                                </div>
                                {selectedFiles.length ? (
                                  <div className="mt-3 space-y-2">
                                    {selectedFiles.map((file) => (
                                      <div
                                        key={`${file.name}-${file.size}-${file.lastModified}`}
                                        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-200"
                                      >
                                        <span className="min-w-0 truncate">
                                          {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                                        </span>
                                        <button
                                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
                                          onClick={() => removeSelectedFile(file)}
                                          aria-label={`Remove ${file.name} from upload selection`}
                                        >
                                          <TrashIcon />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="mt-3 text-xs text-zinc-500">
                                    Supported: MP3, FLAC, WAV, AIFF, ALAC/M4A, DSD, APE, WavPack.
                                  </p>
                                )}
                              </div>
                              <button
                                className="w-full rounded-2xl bg-white px-4 py-3 text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300"
                                disabled={uploadMutation.isPending || selectedFiles.length === 0}
                                onClick={() => uploadMutation.mutate(selectedFiles)}
                              >
                                {uploadMutation.isPending ? "Uploading..." : `Upload ${selectedFiles.length || ""} file(s)`}
                              </button>
                            </div>
                          </div>
                        </Dialog.Content>
                      </Dialog.Portal>
                    </Dialog.Root>
                  </div>
                  <div className="h-[28rem] overflow-y-auto pr-1">
                    <div className="space-y-2">
                        {state.queue.map((item) => (
                          <div
                            key={item.queueItemId}
                            onClick={isController ? () => handleQueueSelect(item.queueItemId) : undefined}
                            className={`group flex items-center gap-3 rounded-[1.4rem] border px-3 py-3 transition ${
                              isController ? "cursor-pointer" : "cursor-default"
                            } ${
                              item.isSelected
                                ? "border-sky-400/60 bg-sky-400/[0.12]"
                                : "border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]"
                            }`}
                          >
                            <button
                              aria-label={`Play ${item.track.displayTitle}`}
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={!isController || controlMutation.isPending || queueMutation.isPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleQueuePlay(item);
                              }}
                            >
                              <PlayIcon />
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <h3 className="truncate font-medium text-white">{item.track.displayTitle}</h3>
                                {item.isSelected ? (
                                  <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-sky-100">
                                    Selected
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 truncate text-sm text-zinc-400">
                                {formatQueueMeta(item.track)}
                                {item.track.durationMs ? ` - ${formatDuration(item.track.durationMs)}` : ""}
                              </p>
                              <p className="mt-1 text-xs text-zinc-500">
                                {item.track.playbackReady
                                  ? "Ready to play"
                                  : item.track.pendingJobStatus
                                    ? `Preparing: ${item.track.pendingJobStatus}`
                                    : "Waiting for asset"}
                              </p>
                            </div>

                            <button
                              aria-label={`Remove ${item.track.displayTitle}`}
                              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={!isController || queueMutation.isPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                queueMutation.mutate({ type: "remove", queueItemId: item.queueItemId });
                              }}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        ))}
                      </div>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="members">
                  <div className="h-[28rem] overflow-y-auto pr-1">
                    <div className="space-y-3">
                        {state.members.map((member) => (
                          <div key={member.memberId} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 p-4">
                            <div>
                              <h3 className="font-medium text-white">{member.displayName}</h3>
                              <p className="mt-1 text-sm text-zinc-400">{member.role}</p>
                            </div>
                            {state.currentMember.role === "owner" && member.role !== "owner" ? (
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                  <button className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white hover:bg-white/5">
                                    Change role
                                  </button>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                  <DropdownMenu.Content className="rounded-2xl border border-white/10 bg-zinc-950 p-2 shadow-xl">
                                    {["controller", "listener"].map((role) => (
                                      <DropdownMenu.Item
                                        key={role}
                                        className="cursor-pointer rounded-xl px-3 py-2 text-sm text-white outline-none hover:bg-white/10"
                                        onSelect={() => roleMutation.mutate({ memberId: member.memberId, role })}
                                      >
                                        Set {role}
                                      </DropdownMenu.Item>
                                    ))}
                                  </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                              </DropdownMenu.Root>
                            ) : null}
                          </div>
                        ))}
                      </div>
                  </div>
                </Tabs.Content>
              </Tabs.Root>
            </div>

          <div
            className={`fixed bottom-4 left-1/2 z-40 -translate-x-1/2 ${
              isPlayerMinimized
                ? "w-[min(720px,calc(100vw-1.5rem))]"
                : "w-[min(1180px,calc(100vw-1.5rem))]"
            } transition-[width] duration-400 ease-[cubic-bezier(0.2,0.9,0.2,1.08)]`}
          >
            {isPlayerMinimized ? (
              <div
                className="player-dock-minimized-enter rounded-[1.75rem] border border-white/10 bg-zinc-950/92 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur-xl transition hover:border-white/15 hover:bg-zinc-950/96"
              >
                <div className="flex items-center gap-3">
                  <button
                    aria-label={state.transport.status === "playing" ? "Pause" : "Play"}
                    className={[
                      "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border text-sm font-medium transition",
                      state.transport.status === "playing"
                        ? "border-sky-300 bg-sky-400 text-zinc-950 hover:bg-sky-300"
                        : "border-white/10 bg-white/5 text-white hover:bg-white/10",
                      !isController || !currentTrack || playbackPending || controlMutation.isPending
                        ? "cursor-not-allowed opacity-40"
                        : ""
                    ].join(" ")}
                    disabled={!isController || !currentTrack || playbackPending || controlMutation.isPending}
                    onClick={(event) => {
                      event.stopPropagation();
                      handlePlayPause();
                    }}
                  >
                    {state.transport.status === "playing" ? <PauseIcon /> : <PlayIcon />}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">
                      {currentTrack?.displayTitle ?? "No track selected"}
                    </div>
                    <div className="truncate text-xs text-zinc-500">{formatTrackFacts(currentTrack)}</div>
                  </div>

                  <div className="shrink-0 text-sm font-medium tabular-nums text-zinc-300">
                    {formatDuration(displayPositionMs)} / {formatDuration(trackDurationMs)}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      aria-label={playbackView.muted ? "Unmute" : "Mute"}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
                      onClick={() => playbackService.toggleMute()}
                    >
                      <VolumeIcon muted={playbackView.muted} />
                    </button>
                    <button
                      aria-label="Expand player"
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
                      onClick={() => setIsPlayerMinimized(false)}
                    >
                      <ExpandIcon />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="player-dock-expanded-enter relative rounded-[2rem] border border-white/10 bg-zinc-950/92 p-4 shadow-2xl shadow-black/50 backdrop-blur-xl sm:p-5">
                <button
                  aria-label="Minimize player"
                  className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
                  onClick={() => setIsPlayerMinimized(true)}
                >
                  <MinimizeIcon />
                </button>

                <div className="grid gap-4 pt-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_240px] xl:items-center xl:pt-0 xl:pr-14">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-emerald-300 text-xs font-semibold uppercase tracking-[0.25em] text-zinc-950">
                      {currentTrack ? "Now" : "Idle"}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-lg font-semibold text-white">
                        {currentTrack?.displayTitle ?? "No track selected"}
                      </div>
                      <div className="truncate text-sm text-zinc-400">{formatTrackFacts(currentTrack)}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-400">
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {isController ? "Controller access" : "Listener mode"}
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {state.transport.status === "playing" ? "Live playback" : formatTransportStatus(state.transport.status)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-4">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {[
                        {
                          label: "Rewind 10 seconds",
                          action: () => handleJump(-10000),
                          disabled: !isController || !currentTrack || playbackPending || controlMutation.isPending,
                          icon: <RewindIcon />
                        },
                        {
                          label: "Previous track",
                          action: () =>
                            controlMutation.mutate({ action: "previous", revision: state.transport.revision }),
                          disabled: !isController || controlMutation.isPending,
                          icon: <PreviousIcon />
                        },
                        {
                          label: state.transport.status === "playing" ? "Pause" : "Play",
                          action: () => handlePlayPause(),
                          disabled: !isController || !currentTrack || playbackPending || controlMutation.isPending,
                          primary: true,
                          icon: state.transport.status === "playing" ? <PauseIcon /> : <PlayIcon />
                        },
                        {
                          label: "Stop",
                          action: () =>
                            controlMutation.mutate({ action: "stop", revision: state.transport.revision }),
                          disabled:
                            !isController ||
                            !state.transport.trackId ||
                            playbackPending ||
                            controlMutation.isPending,
                          icon: <StopIcon />
                        },
                        {
                          label: "Next track",
                          action: () =>
                            controlMutation.mutate({ action: "next", revision: state.transport.revision }),
                          disabled: !isController || controlMutation.isPending,
                          icon: <NextIcon />
                        },
                        {
                          label: "Forward 10 seconds",
                          action: () => handleJump(10000),
                          disabled: !isController || !currentTrack || playbackPending || controlMutation.isPending,
                          icon: <ForwardIcon />
                        }
                      ].map((control) => (
                        <Tooltip.Root key={control.label}>
                          <Tooltip.Trigger asChild>
                            <button
                              aria-label={control.label}
                              className={[
                                "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border text-sm font-medium transition sm:h-12 sm:w-12",
                                control.primary
                                  ? "h-14 w-14 border-sky-300 bg-sky-400 text-zinc-950 hover:bg-sky-300"
                                  : "border-white/10 bg-white/5 text-white hover:bg-white/10",
                                control.disabled ? "cursor-not-allowed opacity-40" : ""
                              ].join(" ")}
                              disabled={control.disabled}
                              onClick={control.action}
                            >
                              {control.icon}
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content className="rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white">
                              {isController ? control.label : "Controller access required"}
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <Slider.Root
                        value={[Math.min(displayPositionMs, trackDurationMs || 1)]}
                        max={Math.max(trackDurationMs || 1, 1)}
                        step={1000}
                        className="relative flex h-6 items-center"
                        disabled={!currentTrack || !isController || playbackPending}
                        onValueCommit={([value]) => handleSeek(value)}
                      >
                        <Slider.Track className="relative h-2 grow rounded-full bg-white/10">
                          <Slider.Range className="absolute h-full rounded-full bg-sky-400" />
                        </Slider.Track>
                        <Slider.Thumb className="block h-4 w-4 rounded-full border border-sky-300 bg-white shadow" />
                      </Slider.Root>
                      <div className="flex items-center justify-between text-sm text-zinc-400">
                        <span>{formatDuration(displayPositionMs)}</span>
                        <span>{formatDuration(trackDurationMs)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Local volume</div>
                        <div className="mt-1 text-sm text-zinc-300">
                          {playbackView.muted ? "Muted" : `${volumePercent}%`}
                        </div>
                      </div>
                      <button
                        aria-label={playbackView.muted ? "Unmute" : "Mute"}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white hover:bg-white/10"
                        onClick={() => playbackService.toggleMute()}
                      >
                        <VolumeIcon muted={playbackView.muted} />
                      </button>
                    </div>
                    <Slider.Root
                      value={[volumePercent]}
                      max={100}
                      step={1}
                      className="relative flex h-6 items-center"
                      onValueChange={([value]) => playbackService.setVolume(value / 100)}
                    >
                      <Slider.Track className="relative h-2 grow rounded-full bg-white/10">
                        <Slider.Range className="absolute h-full rounded-full bg-emerald-300" />
                      </Slider.Track>
                      <Slider.Thumb className="block h-4 w-4 rounded-full border border-emerald-200 bg-white shadow" />
                    </Slider.Root>
                    <div className="mt-3 text-xs leading-5 text-zinc-500">
                      Local volume only. Shared play, pause, skip, and seek require controller access.
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <Toast.Root
          open={toast.open}
          onOpenChange={(open) => setToast((current) => ({ ...current, open }))}
          className="fixed bottom-6 right-6 w-80 rounded-2xl border border-white/10 bg-zinc-950 p-4 shadow-xl"
        >
          <Toast.Title className="text-sm font-semibold text-white">{toast.title}</Toast.Title>
          <Toast.Description className="mt-2 text-sm text-zinc-300">{toast.description}</Toast.Description>
        </Toast.Root>
        <Toast.Viewport className="fixed bottom-0 right-0 flex max-w-[100vw] flex-col p-6 outline-none" />
      </Tooltip.Provider>
    </Toast.Provider>
  );
}
