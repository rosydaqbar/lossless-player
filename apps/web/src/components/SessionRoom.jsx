import * as Toast from "@radix-ui/react-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  connectSessionBot,
  controlPlayback,
  deleteSession,
  disconnectSessionBot,
  fetchSessionBots,
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

function isAutoplayBlockedErrorMessage(message) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("didn't interact") ||
    normalized.includes("user gesture") ||
    normalized.includes("notallowederror") ||
    normalized.includes("play() failed") ||
    normalized.includes("autoplay")
  );
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

function BotIcon() {
  return (
    <ControlIcon className="h-4 w-4">
      <rect x="5" y="7" width="14" height="10" rx="2" />
      <path d="M9 7V5" />
      <path d="M15 7V5" />
      <circle cx="10" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12" r="1" fill="currentColor" stroke="none" />
    </ControlIcon>
  );
}

function CopyIcon() {
  return (
    <ControlIcon className="h-3.5 w-3.5">
      <rect x="8" y="8" width="10" height="10" rx="2" />
      <rect x="5" y="5" width="10" height="10" rx="2" />
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

function resolveArtworkUrl(track, sessionId, accessToken) {
  if (!track || !sessionId || !accessToken) {
    return "";
  }

  const artworkAsset = track.assets?.find((asset) => asset.kind === "artwork" && asset.assetId);
  if (!artworkAsset) {
    return "";
  }

  const searchParams = new URLSearchParams({
    sessionId,
    accessToken
  });

  return `${getApiUrl()}/api/tracks/${track.trackId}/stream/${artworkAsset.assetId}?${searchParams.toString()}`;
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
  const [seekPreviewMs, setSeekPreviewMs] = useState(null);
  const [awaitingGestureUnlock, setAwaitingGestureUnlock] = useState(false);
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("upload") !== "1") {
      return;
    }

    setUploadOpen(true);
    searchParams.delete("upload");
    const nextSearch = searchParams.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, []);


  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSessionState(sessionId, accessToken),
    enabled: Boolean(sessionId && accessToken),
    refetchInterval: 3000
  });

  const botsQuery = useQuery({
    queryKey: ["session-bots", sessionId],
    queryFn: () => fetchSessionBots(sessionId, accessToken),
    enabled: Boolean(sessionId && accessToken),
    refetchInterval: 5000
  });

  const state = sessionQuery.data;
  const bots = botsQuery.data?.bots ?? [];
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
  const memberRole = state?.currentMember?.role ?? "";
  const canManagePlayback = memberRole === "owner" || memberRole === "controller";
  const canUploadTracks = canManagePlayback;
  const canDeleteTracks = canManagePlayback;
  const canViewBotStatus = memberRole !== "listener";
  const trackDurationMs = currentTrack?.durationMs ?? playbackView.durationMs ?? 0;
  const displayPositionMs = trackDurationMs
    ? Math.min(playbackView.currentTimeMs, trackDurationMs)
    : playbackView.currentTimeMs;
  const effectiveSeekPositionMs = seekPreviewMs ?? displayPositionMs;
  const volumePercent = Math.round((playbackView.muted ? 0 : playbackView.volume) * 100);
  const playbackPending = Boolean(currentTrack && !currentTrack.playbackReady);
  const artworkUrl = useMemo(
    () => resolveArtworkUrl(currentTrack, sessionId, accessToken),
    [accessToken, currentTrack, sessionId]
  );
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
    setSeekPreviewMs(null);
  }, [state?.transport?.revision, state?.transport?.trackId]);
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
      if (!state?.transport || awaitingGestureUnlock) {
        return;
      }

      if (!audioArmed) {
        if (state.transport.status === "playing") {
          setAwaitingGestureUnlock(true);
        }
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
      const message = error instanceof Error ? error.message : "Playback failed.";
      if (isAutoplayBlockedErrorMessage(message)) {
        setAwaitingGestureUnlock(true);
        setToast({
          open: true,
          title: "Playback blocked",
          description: "Tap anywhere once to resume playback after refresh."
        });
        return;
      }

      setToast({
        open: true,
        title: "Playback error",
        description: message
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
    state?.transport?.revision,
    awaitingGestureUnlock
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

  const connectBotMutation = useMutation({
    mutationFn: (botId) => connectSessionBot(sessionId, botId, accessToken),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["session-bots", sessionId] });
      setToast({ open: true, title: "Bot connected", description: "Discord bot is now bound to this session." });
    },
    onError(error) {
      setToast({ open: true, title: "Bot connect failed", description: error.message });
    }
  });

  const disconnectBotMutation = useMutation({
    mutationFn: (botId) => disconnectSessionBot(sessionId, botId, accessToken),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["session-bots", sessionId] });
      setToast({ open: true, title: "Bot disconnected", description: "Discord bot is now waiting for a new session." });
    },
    onError(error) {
      setToast({ open: true, title: "Bot disconnect failed", description: error.message });
    }
  });

  async function runControl(action, extra = {}) {
    const getLatestState = () => queryClient.getQueryData(["session", sessionId]) ?? state;
    const latest = getLatestState();
    if (!latest?.transport) {
      return;
    }

    const buildPayload = (revision) => ({
      action,
      revision,
      ...extra
    });

    try {
      return await controlMutation.mutateAsync(buildPayload(latest.transport.revision));
    } catch (error) {
      if (!String(error?.message ?? "").toLowerCase().includes("revision conflict")) {
        throw error;
      }

      const refreshed = await queryClient.fetchQuery({
        queryKey: ["session", sessionId],
        queryFn: () => fetchSessionState(sessionId, accessToken)
      });

      return controlMutation.mutateAsync(buildPayload(refreshed.transport.revision));
    }
  }

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

    if (!state?.transport?.trackId || state.transport.status !== "playing") {
      return;
    }

    const transportQueueIndex = state.queue.findIndex((item) => item.trackId === state.transport.trackId);
    const selectedQueueIndex = state.queue.findIndex((item) => item.isSelected);
    const currentQueueIndex = transportQueueIndex >= 0 ? transportQueueIndex : selectedQueueIndex;
    const hasNextTrack = currentQueueIndex >= 0 && currentQueueIndex < state.queue.length - 1;

    if (!hasNextTrack) {
      return;
    }

    runControl("next").catch(() => {});
  }, [playbackView.endedCount, runControl, state?.queue, state?.transport?.status, state?.transport?.trackId]);

  async function ensureLocalAudioReady() {
    if (audioArmed) {
      return;
    }

    await playbackService.arm();
    setAwaitingGestureUnlock(false);
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

  async function handleActivateAudioArm() {
    try {
      await playbackService.arm();
      setAudioArmed(true);
      setAwaitingGestureUnlock(false);
      if (state?.transport) {
        playbackService.syncTransport(state.transport, state.serverTimeMs);
      }
      setToast({
        open: true,
        title: "Audio activated",
        description: "Playback is now synced on this device."
      });
    } catch (error) {
      setToast({
        open: true,
        title: "Playback blocked",
        description: error instanceof Error ? error.message : "Could not activate audio on this device."
      });
    }
  }

  async function copyToClipboard(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setToast({
        open: true,
        title: `${label} copied`,
        description: value
      });
    } catch {
      setToast({
        open: true,
        title: "Copy failed",
        description: `Could not copy ${label.toLowerCase()}.`
      });
    }
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
      runControl("pause", { positionMs: playbackView.currentTimeMs }).catch(() => {});
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

    runControl("play").catch(() => {});
  }

  function handleSeek(positionMs) {
    if (!canManagePlayback || !currentTrack || playbackPending) {
      return;
    }

    const nextPositionMs = clamp(Math.round(positionMs), 0, Math.max(trackDurationMs || 0, 0));
    runControl("seek", { positionMs: nextPositionMs }).catch(() => {});
  }

  function handleJump(deltaMs) {
    if (!currentTrack) {
      return;
    }

    const basePositionMs = seekPreviewMs ?? displayPositionMs;
    handleSeek(clamp(basePositionMs + deltaMs, 0, trackDurationMs || basePositionMs + deltaMs));
  }

  async function handleQueueSelect(queueItemId) {
    if (!canManagePlayback || queueMutation.isPending) {
      return;
    }

    try {
      await queueMutation.mutateAsync({ type: "select", queueItemId });
    } catch {
      // Error toast is handled by the mutation itself.
    }
  }

  async function handleQueuePlay(item) {
    if (!canManagePlayback || queueMutation.isPending || controlMutation.isPending) {
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

    if (!window.confirm("Abandon this room and delete all uploaded music?")) {
      return;
    }

    abandonMutation.mutate();
  }

  function handleLeaveRoom() {
    playbackService.clearSource();
    clearSession("You left the room.");
  }

  if (sessionQuery.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading session...</div>;
  }

  if (shouldReturnToHome) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-12">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Session unavailable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {sessionQuery.error?.message ?? "Failed to load session."}
            </p>
            <Button onClick={() => clearSession("Reconnect to a room.")}>Back to room selection</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!state) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading session...</div>;
  }

  return (
    <Toast.Provider swipeDirection="right">
      <TooltipProvider delayDuration={120}>
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 pb-44 pt-8">
          <Card className="card-transition-in">
            <CardHeader className="gap-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-3">
                  <div className="text-xs text-muted-foreground">LIVE ROOM</div>
                  <CardTitle>{state.sessionName}</CardTitle>
                </div>
                <Button
                  variant="destructive"
                  disabled={abandonMutation.isPending && state.currentMember.role !== "listener"}
                  onClick={state.currentMember.role === "listener" ? handleLeaveRoom : handleAbandonRoom}
                >
                  {state.currentMember.role === "listener"
                    ? "Leave Room"
                    : abandonMutation.isPending
                      ? "Abandoning..."
                      : "Abandon Room"}
                </Button>
              </div>

              <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">
                  Role {state.currentMember.role}
                </Badge>
                <div className="inline-flex items-center gap-1">
                  <Badge variant="outline">Session {state.sessionId}</Badge>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="Copy session id"
                    onClick={() => copyToClipboard(state.sessionId, "Session ID")}
                  >
                    <CopyIcon />
                  </Button>
                </div>
                {state.listenerCode ? (
                  <div className="inline-flex items-center gap-1">
                    <Badge variant="outline">Listener code {state.listenerCode}</Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-6 w-6"
                      aria-label="Copy listener code"
                      onClick={() => copyToClipboard(state.listenerCode, "Listener code")}
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                ) : null}
                {state.controllerCode ? (
                  <Badge variant="outline">Controller code {state.controllerCode}</Badge>
                ) : null}
                {playbackPending ? (
                  <Badge variant="outline">
                    {currentTrack?.pendingJobStatus === "failed" ? "Playback prep failed" : "Preparing playback"}
                  </Badge>
                ) : null}
              </div>

              <Card size="sm">
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${audioArmed ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/50"}`}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground">
                        {audioArmed ? "Audio active" : "Audio inactive"}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {audioArmed
                        ? "This device is synced for shared playback."
                        : "Activate audio on this device to hear the room."}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleAudioToggle}>
                    {audioArmed ? "Deactivate Audio" : "Activate Audio"}
                  </Button>
                </CardContent>
              </Card>
            </CardHeader>
          </Card>

          {canViewBotStatus ? (
          <Card className="card-transition-in [animation-delay:40ms]">
            <CardHeader className="gap-2">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BotIcon />
                  Discord Bot Status
                </CardTitle>
                <Badge variant={botsQuery.isFetching ? "secondary" : "outline"}>
                  {botsQuery.isFetching ? "Refreshing" : "Live"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {botsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading bots...</p> : null}
              {!botsQuery.isLoading && bots.length === 0 ? (
                <p className="text-sm text-muted-foreground">No bots available.</p>
              ) : null}
              {bots.map((bot) => {
                const connectedToCurrentSession = Boolean(bot.connectedToSession);
                const busyWithOtherSession = Boolean(bot.connectedSessionId && !connectedToCurrentSession);

                return (
                  <Card key={bot.botId} size="sm" className="border-border/70">
                    <CardContent className="grid gap-3 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate font-medium">{bot.name}</p>
                            <Badge variant={bot.online ? "secondary" : "outline"}>{bot.online ? "Online" : "Offline"}</Badge>
                            <Badge variant={connectedToCurrentSession ? "secondary" : "outline"}>
                              {connectedToCurrentSession ? "Connected to this session" : bot.waitingForConnect ? "Waiting for connect" : "Connected elsewhere"}
                            </Badge>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {bot.user?.tag ?? "Unknown account"} {bot.user?.id ? `- ${bot.user.id}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                              !bot.online ||
                              connectedToCurrentSession ||
                              busyWithOtherSession ||
                              connectBotMutation.isPending ||
                              disconnectBotMutation.isPending
                            }
                            onClick={() => connectBotMutation.mutate(bot.botId)}
                          >
                            Connect
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              !connectedToCurrentSession ||
                              connectBotMutation.isPending ||
                              disconnectBotMutation.isPending
                            }
                            onClick={() => disconnectBotMutation.mutate(bot.botId)}
                          >
                            Disconnect
                          </Button>
                        </div>
                      </div>
                      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                        <p>Alive: {bot.alive ? "yes" : "no"}</p>
                        <p>Gateway status: {bot.wsStatus}</p>
                        <p>Ping: {Number.isFinite(bot.pingMs) ? `${Math.round(bot.pingMs)} ms` : "n/a"}</p>
                        <p>Channel: {bot.channelId ?? "none"}</p>
                        <p>Session: {bot.connectedSessionId ?? "none"}</p>
                        <p>Message: {bot.messageId ?? "none"}</p>
                        <p className="sm:col-span-2">Connected at: {bot.connectedAt ? new Date(bot.connectedAt).toLocaleString() : "n/a"}</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </CardContent>
          </Card>
          ) : null}

          <Card className="card-transition-in [animation-delay:80ms]">
            <CardContent className="p-6">
              <Tabs defaultValue="queue" className="space-y-4">
                <TabsList className="grid w-[220px] grid-cols-2">
                  <TabsTrigger value="queue">
                    Queue
                  </TabsTrigger>
                  <TabsTrigger value="members">
                    Members
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="queue">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">Tracks</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {state.queue.length} track{state.queue.length === 1 ? "" : "s"} in this room
                      </div>
                    </div>
                    <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
                      <DialogTrigger asChild>
                        <Button className="inline-flex items-center gap-2" disabled={!canUploadTracks}>
                          <UploadIcon />
                          Upload track
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-[96vw] sm:max-w-3xl">
                        <div className="flex max-h-[82vh] min-h-0 flex-col gap-4">
                          <DialogHeader>
                            <DialogTitle className="text-base sm:text-lg">Add tracks to this room</DialogTitle>
                            <DialogDescription>
                              Files are stored on the server for this room so everyone hears the same queue.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="min-h-0 flex-1 space-y-4">
                              <input
                                ref={fileInputRef}
                                multiple
                                type="file"
                                accept=".mp3,.flac,.wav,.aiff,.aif,.m4a,.alac,.dsf,.dff,.ape,.wv"
                                className="hidden"
                                onChange={handleFileSelection}
                              />
                              <Button
                                variant="outline"
                                className="w-full border-dashed"
                                disabled={!canUploadTracks}
                                onClick={() => fileInputRef.current?.click()}
                              >
                                {selectedFiles.length ? "Add more files" : "Browse files"}
                              </Button>
                              <Input
                                readOnly
                                value={selectedFiles.length ? selectedFiles.map((file) => file.name).join(", ") : ""}
                                placeholder="No files selected yet"
                              />
                              <Card>
                                <CardContent className="space-y-3 p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <span>{selectedFiles.length ? `${selectedFiles.length} file(s) selected` : "No files selected yet"}</span>
                                  {selectedFiles.length ? (
                                      <Button variant="outline" size="sm" onClick={clearSelectedFiles} disabled={!canUploadTracks}>
                                        Clear
                                      </Button>
                                  ) : null}
                                </div>
                                  {selectedFiles.length ? (
                                   <ScrollArea className="h-[38vh] min-h-40 pr-1">
                                    <div className="space-y-2">
                                     {selectedFiles.map((file) => (
                                       <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                                        <span className="min-w-0 truncate">
                                          {file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)
                                        </span>
                                        <Button
                                          variant="outline"
                                          size="icon"
                                          disabled={!canUploadTracks}
                                          onClick={() => removeSelectedFile(file)}
                                          aria-label={`Remove ${file.name} from upload selection`}
                                        >
                                          <TrashIcon />
                                        </Button>
                                       </div>
                                      ))}
                                    </div>
                                   </ScrollArea>
                                 ) : (
                                  <p className="text-xs text-muted-foreground">
                                     Supported: MP3, FLAC, WAV, AIFF, ALAC/M4A, DSD, APE, WavPack.
                                  </p>
                                 )}
                                </CardContent>
                              </Card>
                              <Button
                                className="w-full"
                                disabled={!canUploadTracks || uploadMutation.isPending || selectedFiles.length === 0}
                                onClick={() => uploadMutation.mutate(selectedFiles)}
                              >
                                {uploadMutation.isPending ? "Uploading..." : `Upload ${selectedFiles.length || ""} file(s)`}
                              </Button>
                          </div>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                  <ScrollArea className="h-[28rem]">
                    <div className="space-y-2 px-0.5">
                        {state.queue.map((item) => (
                          <Card
                            key={item.queueItemId}
                            onClick={canManagePlayback ? () => handleQueueSelect(item.queueItemId) : undefined}
                            onKeyDown={
                              canManagePlayback
                                ? (event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      handleQueueSelect(item.queueItemId);
                                    }
                                  }
                                : undefined
                            }
                            role={canManagePlayback ? "button" : undefined}
                            tabIndex={canManagePlayback ? 0 : undefined}
                            className={`card-pop-in group border border-border/70 ring-0 ${
                              canManagePlayback
                                ? "cursor-pointer transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                                : "cursor-default"
                            } py-0 gap-0 data-[selected=true]:border-primary/50 data-[selected=true]:bg-accent`}
                            data-selected={item.isSelected ? "true" : "false"}
                          >
                            <CardContent className="flex items-center gap-3 p-3 sm:p-3.5">
                              <Button
                                aria-label={`Play ${item.track.displayTitle}`}
                                variant="outline"
                                size="icon"
                                disabled={!canManagePlayback || controlMutation.isPending || queueMutation.isPending}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleQueuePlay(item);
                                }}
                              >
                                <PlayIcon />
                              </Button>

                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <h3 className="truncate font-medium">{item.track.displayTitle}</h3>
                                {item.isSelected ? (
                                  <Badge variant="secondary">
                                    Selected
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="mt-1 truncate text-sm text-muted-foreground">
                                {formatQueueMeta(item.track)}
                                {item.track.durationMs ? ` - ${formatDuration(item.track.durationMs)}` : ""}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.track.playbackReady
                                  ? "Ready to play"
                                  : item.track.pendingJobStatus
                                    ? `Preparing: ${item.track.pendingJobStatus}`
                                    : "Waiting for asset"}
                              </p>
                            </div>

                            <Button
                              aria-label={`Remove ${item.track.displayTitle}`}
                              variant="outline"
                              size="icon"
                              disabled={!canDeleteTracks || queueMutation.isPending}
                              onClick={(event) => {
                                event.stopPropagation();
                                queueMutation.mutate({ type: "remove", queueItemId: item.queueItemId });
                              }}
                            >
                              <TrashIcon />
                            </Button>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="members">
                  <ScrollArea className="h-[28rem]">
                    <div className="space-y-3 px-0.5">
                        {state.members.map((member) => (
                           <Card key={member.memberId} className="card-pop-in">
                            <CardContent className="flex items-center justify-between p-4">
                            <div>
                              <h3 className="font-medium text-foreground">{member.displayName}</h3>
                              <p className="mt-1 text-sm text-muted-foreground">{member.role}</p>
                            </div>
                            {state.currentMember.role === "owner" && member.role !== "owner" ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="outline" size="sm">
                                    Change role
                                  </Button>
                                </DropdownMenuTrigger>
                                  <DropdownMenuContent>
                                    {["controller", "listener"].map((role) => (
                                      <DropdownMenuItem
                                        key={role}
                                        className="cursor-pointer rounded-md px-3 py-2 text-sm text-foreground outline-none hover:bg-muted"
                                        onSelect={() => roleMutation.mutate({ memberId: member.memberId, role })}
                                      >
                                        Set {role}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                            </CardContent>
                          </Card>
                        ))}
                       </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <div
            className={`fixed bottom-4 left-1/2 z-40 -translate-x-1/2 ${
              isPlayerMinimized
                ? "w-[min(720px,calc(100vw-1.5rem))]"
                : "w-[min(1180px,calc(100vw-1.5rem))]"
            } transition-[width] duration-400 ease-[cubic-bezier(0.2,0.9,0.2,1.08)]`}
          >
            {isPlayerMinimized ? (
              <Card className="card-transition-in [animation-delay:140ms]">
                <CardContent className="p-3">
                <div className="flex items-center gap-3">
                    <Button
                      aria-label={state.transport.status === "playing" ? "Pause" : "Play"}
                      variant={state.transport.status === "playing" ? "default" : "outline"}
                      size="icon"
                      disabled={!canManagePlayback || !currentTrack || playbackPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        handlePlayPause();
                      }}
                    >
                      {state.transport.status === "playing" ? <PauseIcon /> : <PlayIcon />}
                    </Button>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {currentTrack?.displayTitle ?? "No track selected"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{formatTrackFacts(currentTrack)}</div>
                  </div>

                  <div className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                    {formatDuration(displayPositionMs)} / {formatDuration(trackDurationMs)}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      aria-label={playbackView.muted ? "Unmute" : "Mute"}
                      variant="outline"
                      size="icon"
                      onClick={() => playbackService.toggleMute()}
                    >
                      <VolumeIcon muted={playbackView.muted} />
                    </Button>
                    <Button
                      aria-label="Expand player"
                      variant="outline"
                      size="icon"
                      onClick={() => setIsPlayerMinimized(false)}
                    >
                      <ExpandIcon />
                    </Button>
                  </div>
                </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="card-transition-in relative [animation-delay:140ms]">
                <CardContent className="p-4">
                <Button
                  aria-label="Minimize player"
                  className="absolute right-4 top-4 z-10"
                  variant="outline"
                  size="icon"
                  onClick={() => setIsPlayerMinimized(true)}
                >
                  <MinimizeIcon />
                </Button>

                <div className="grid gap-4 pt-8 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)_240px] xl:items-center xl:pt-0 xl:pr-14">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted">
                      {artworkUrl ? (
                        <img src={artworkUrl} alt={currentTrack?.displayTitle ?? "Album artwork"} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-semibold text-muted-foreground">
                          {currentTrack ? "Now" : "Idle"}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-lg font-semibold">
                        {currentTrack?.displayTitle ?? "No track selected"}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">{formatTrackFacts(currentTrack)}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline">
                          {canManagePlayback ? "Control enabled" : "Listener mode"}
                        </Badge>
                        <Badge variant="outline">
                          {state.transport.status === "playing" ? "Live playback" : formatTransportStatus(state.transport.status)}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 space-y-4">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {[
                        {
                          label: "Rewind 10 seconds",
                          action: () => handleJump(-10000),
                          disabled: !canManagePlayback || !currentTrack || playbackPending,
                          icon: <RewindIcon />
                        },
                        {
                          label: "Previous track",
                          action: () => runControl("previous").catch(() => {}),
                          disabled: !canManagePlayback,
                          icon: <PreviousIcon />
                        },
                        {
                          label: state.transport.status === "playing" ? "Pause" : "Play",
                          action: () => handlePlayPause(),
                          disabled: !canManagePlayback || !currentTrack || playbackPending,
                          primary: true,
                          icon: state.transport.status === "playing" ? <PauseIcon /> : <PlayIcon />
                        },
                        {
                          label: "Stop",
                          action: () => runControl("stop").catch(() => {}),
                          disabled:
                            !canManagePlayback ||
                            !state.transport.trackId ||
                            playbackPending,
                          icon: <StopIcon />
                        },
                        {
                          label: "Next track",
                          action: () => runControl("next").catch(() => {}),
                          disabled: !canManagePlayback,
                          icon: <NextIcon />
                        },
                        {
                          label: "Forward 10 seconds",
                          action: () => handleJump(10000),
                          disabled: !canManagePlayback || !currentTrack || playbackPending,
                          icon: <ForwardIcon />
                        }
                      ].map((control) => (
                        <Tooltip key={control.label}>
                          <TooltipTrigger asChild>
                            <Button
                              aria-label={control.label}
                              variant={control.primary ? "default" : "outline"}
                              size="icon"
                              className={control.primary ? "h-14 w-14" : "h-12 w-12"}
                              disabled={control.disabled}
                              onClick={control.action}
                            >
                              {control.icon}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {canManagePlayback ? control.label : "Controller access required"}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <Slider
                        value={[Math.min(effectiveSeekPositionMs, trackDurationMs || 1)]}
                        max={Math.max(trackDurationMs || 1, 1)}
                        step={1000}
                        className="h-6"
                        disabled={!currentTrack || !canManagePlayback || playbackPending}
                        onValueChange={([value]) => setSeekPreviewMs(value)}
                        onValueCommit={([value]) => {
                          setSeekPreviewMs(null);
                          handleSeek(value);
                        }}
                      />
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <span>{formatDuration(effectiveSeekPositionMs)}</span>
                        <span>{formatDuration(trackDurationMs)}</span>
                      </div>
                    </div>
                  </div>

                    <Card>
                      <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Local volume</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {playbackView.muted ? "Muted" : `${volumePercent}%`}
                        </div>
                      </div>
                      <Button
                        aria-label={playbackView.muted ? "Unmute" : "Mute"}
                        variant="outline"
                        size="icon"
                        onClick={() => playbackService.toggleMute()}
                      >
                        <VolumeIcon muted={playbackView.muted} />
                      </Button>
                    </div>
                    <Slider
                      value={[volumePercent]}
                      max={100}
                      step={1}
                      className="h-6"
                      onValueChange={([value]) => playbackService.setVolume(value / 100)}
                    />
                    <div className="mt-3 text-xs leading-5 text-muted-foreground">
                      Local volume only. Shared play, pause, skip, seek, upload, and delete require controller access.
                    </div>
                      </CardContent>
                   </Card>
                </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <Dialog open={awaitingGestureUnlock} onOpenChange={(open) => setAwaitingGestureUnlock(open)}>
          <DialogContent className="max-w-md" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Activate audio on this device</DialogTitle>
              <DialogDescription>
                This room is already playing, but your browser requires one interaction before audio can start.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAwaitingGestureUnlock(false)}>
                Later
              </Button>
              <Button onClick={handleActivateAudioArm}>Activate Audio</Button>
            </div>
          </DialogContent>
        </Dialog>

        <Toast.Root
          open={toast.open}
          onOpenChange={(open) => setToast((current) => ({ ...current, open }))}
          className="fixed bottom-6 right-6 w-80 rounded-lg border border-border/70 bg-card p-4 shadow-xl"
        >
          <Toast.Title className="text-sm font-semibold text-foreground">{toast.title}</Toast.Title>
          <Toast.Description className="mt-2 text-sm text-muted-foreground">{toast.description}</Toast.Description>
        </Toast.Root>
        <Toast.Viewport className="fixed bottom-0 right-0 flex max-w-[100vw] flex-col p-6 outline-none" />
      </TooltipProvider>
    </Toast.Provider>
  );
}
