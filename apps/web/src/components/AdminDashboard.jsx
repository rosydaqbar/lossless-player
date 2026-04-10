import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  adminDeleteSession,
  adminDeleteTrack,
  adminLogin,
  adminWipeAll,
  fetchAdminOverview
} from "../lib/api.js";

const adminStorageKey = "lossless-player-admin-token";

function readInitialAdminToken() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.sessionStorage.getItem(adminStorageKey) ?? "";
}

function formatDuration(durationMs) {
  if (!durationMs) {
    return "0:00";
  }

  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function AdminDashboard() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [adminToken, setAdminToken] = useState(readInitialAdminToken);
  const [errorMessage, setErrorMessage] = useState("");

  const overviewQuery = useQuery({
    queryKey: ["admin-overview"],
    queryFn: () => fetchAdminOverview(adminToken),
    enabled: Boolean(adminToken),
    refetchInterval: 5000
  });

  useEffect(() => {
    if (overviewQuery.error?.status === 401) {
      window.sessionStorage.removeItem(adminStorageKey);
      setAdminToken("");
      setErrorMessage("Admin session expired. Enter the password again.");
    }
  }, [overviewQuery.error?.status]);

  const loginMutation = useMutation({
    mutationFn: adminLogin,
    onSuccess(data) {
      window.sessionStorage.setItem(adminStorageKey, data.adminToken);
      setAdminToken(data.adminToken);
      setPassword("");
      setErrorMessage("");
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError(error) {
      setErrorMessage(error.message);
    }
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (sessionId) => adminDeleteSession(adminToken, sessionId),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError(error) {
      setErrorMessage(error.message);
    }
  });

  const deleteTrackMutation = useMutation({
    mutationFn: (trackId) => adminDeleteTrack(adminToken, trackId),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError(error) {
      setErrorMessage(error.message);
    }
  });

  const wipeMutation = useMutation({
    mutationFn: () => adminWipeAll(adminToken),
    onSuccess() {
      queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError(error) {
      setErrorMessage(error.message);
    }
  });

  const busy = loginMutation.isPending || deleteSessionMutation.isPending || deleteTrackMutation.isPending || wipeMutation.isPending;

  const overview = overviewQuery.data;
  const sessionRows = useMemo(() => overview?.sessions ?? [], [overview?.sessions]);
  const trackRows = useMemo(() => overview?.tracks ?? [], [overview?.tracks]);

  if (!adminToken) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-6 py-12">
        <div className="w-full rounded-[2rem] border border-white/10 bg-black/30 p-8 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="inline-flex rounded-full border border-rose-400/20 bg-rose-400/10 px-4 py-1 text-xs uppercase tracking-[0.3em] text-rose-100">
            Admin Dashboard
          </div>
          <h1 className="mt-6 text-4xl font-semibold text-white">Restricted access for admin</h1>
          <p className="mt-3 max-w-2xl text-zinc-300">
            This panel can delete live sessions and uploaded music immediately. Username is fixed to <span className="font-semibold text-white">admin</span>.
          </p>
          <div className="mt-8 max-w-md space-y-4">
            <label className="flex flex-col gap-2 text-sm text-zinc-200">
              <span>Password</span>
              <input
                type="password"
                value={password}
                placeholder="Breakc0de!"
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-rose-300"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button
              className="w-full rounded-2xl bg-rose-300 px-4 py-3 text-sm font-medium text-zinc-950 transition hover:bg-rose-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300"
              disabled={loginMutation.isPending || !password.trim()}
              onClick={() => loginMutation.mutate(password)}
            >
              {loginMutation.isPending ? "Checking password..." : "Enter admin dashboard"}
            </button>
            {errorMessage ? <p className="text-sm text-rose-200">{errorMessage}</p> : null}
            <button
              className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white hover:bg-white/5"
              onClick={() => {
                window.location.pathname = "/";
              }}
            >
              Back to player
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 shadow-2xl shadow-black/30 backdrop-blur">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="inline-flex rounded-full border border-rose-400/20 bg-rose-400/10 px-4 py-1 text-xs uppercase tracking-[0.3em] text-rose-100">
              Admin Dashboard
            </div>
            <h1 className="text-4xl font-semibold text-white">Session and upload control</h1>
            <p className="max-w-3xl text-sm text-zinc-300">
              Deleting a session or track pushes an immediate error to connected players. Wipe all removes every live room and uploaded music.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white hover:bg-white/5"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-overview"] })}
            >
              Refresh
            </button>
            <button
              className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white hover:bg-white/5"
              onClick={() => {
                window.sessionStorage.removeItem(adminStorageKey);
                setAdminToken("");
                queryClient.removeQueries({ queryKey: ["admin-overview"] });
              }}
            >
              Log out
            </button>
            <button
              className="rounded-2xl border border-white/10 px-4 py-3 text-sm text-white hover:bg-white/5"
              onClick={() => {
                window.location.pathname = "/";
              }}
            >
              Open player
            </button>
            <button
              className="rounded-2xl bg-rose-300 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-rose-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300"
              disabled={busy || !sessionRows.length}
              onClick={() => {
                if (window.confirm("Wipe every session and every uploaded music file?")) {
                  wipeMutation.mutate();
                }
              }}
            >
              {wipeMutation.isPending ? "Wiping everything..." : "Wipe all"}
            </button>
          </div>
        </div>
        {errorMessage ? <p className="mt-4 text-sm text-rose-200">{errorMessage}</p> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
          <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Sessions</div>
          <div className="mt-3 text-4xl font-semibold text-white">{overview?.summary.sessionCount ?? 0}</div>
        </div>
        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
          <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Uploaded music</div>
          <div className="mt-3 text-4xl font-semibold text-white">{overview?.summary.trackCount ?? 0}</div>
        </div>
        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
          <div className="text-xs uppercase tracking-[0.3em] text-zinc-500">Assets</div>
          <div className="mt-3 text-4xl font-semibold text-white">{overview?.summary.assetCount ?? 0}</div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-white">Live sessions</h2>
            <div className="text-sm text-zinc-400">{sessionRows.length} room(s)</div>
          </div>
          <div className="mt-5 space-y-3">
            {sessionRows.length ? (
              sessionRows.map((session) => (
                <div key={session.sessionId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-medium text-white">{session.sessionName}</div>
                      <div className="mt-1 text-xs text-zinc-500">{session.sessionId}</div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-300">
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {session.memberCount} member(s)
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {session.trackCount} track(s)
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {session.playbackStatus}
                        </span>
                      </div>
                      <div className="mt-3 text-sm text-zinc-400">
                        Current track: {session.currentTrackTitle ?? "none"}
                      </div>
                    </div>
                    <button
                      className="rounded-2xl bg-rose-300 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-rose-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete session "${session.sessionName}"?`)) {
                          deleteSessionMutation.mutate(session.sessionId);
                        }
                      }}
                    >
                      Delete session
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400">
                No sessions exist right now.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-white">Uploaded music</h2>
            <div className="text-sm text-zinc-400">{trackRows.length} track(s)</div>
          </div>
          <div className="mt-5 space-y-3">
            {trackRows.length ? (
              trackRows.map((track) => (
                <div key={track.trackId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-medium text-white">{track.displayTitle}</div>
                      <div className="mt-1 text-sm text-zinc-400">
                        {track.sessionName} • {track.mimeType ?? "unknown"} • {track.codec ?? "unknown codec"}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-300">
                        {track.sampleRate ? (
                          <span className="rounded-full border border-white/10 px-2 py-1">{track.sampleRate} Hz</span>
                        ) : null}
                        {track.bitDepth ? (
                          <span className="rounded-full border border-white/10 px-2 py-1">{track.bitDepth}-bit</span>
                        ) : null}
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {formatDuration(track.durationMs)}
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {track.assetCount} asset(s)
                        </span>
                      </div>
                      <div className="mt-3 text-xs text-zinc-500">{track.trackId}</div>
                    </div>
                    <button
                      className="rounded-2xl bg-rose-300 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-rose-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-300"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete "${track.displayTitle}" from all players now?`)) {
                          deleteTrackMutation.mutate(track.trackId);
                        }
                      }}
                    >
                      Delete music
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400">
                No uploaded music exists right now.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
