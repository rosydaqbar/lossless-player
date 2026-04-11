import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
        <Card className="w-full">
          <CardHeader>
            <Badge variant="secondary">Admin Dashboard</Badge>
            <CardTitle className="mt-2">Restricted access for admin</CardTitle>
            <CardDescription>
              This panel can delete live sessions and uploaded music immediately. Username is fixed to <span className="font-semibold text-foreground">admin</span>.
            </CardDescription>
          </CardHeader>
          <CardContent className="max-w-md space-y-4">
            <label className="flex flex-col gap-2 text-sm text-muted-foreground">
              <span>Password</span>
              <Input
                type="password"
                value={password}
                placeholder="Breakc0de!"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <Button
              className="w-full"
              disabled={loginMutation.isPending || !password.trim()}
              onClick={() => loginMutation.mutate(password)}
            >
              {loginMutation.isPending ? "Checking password..." : "Enter admin dashboard"}
            </Button>
            {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
            <Button variant="outline" className="w-full" onClick={() => { window.location.pathname = "/"; }}>
              Back to player
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <Card>
        <CardHeader className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <Badge variant="secondary">Admin Dashboard</Badge>
            <CardTitle>Session and upload control</CardTitle>
            <CardDescription>
              Deleting a session or track pushes an immediate error to connected players. Wipe all removes every live room and uploaded music.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["admin-overview"] })}>Refresh</Button>
            <Button
              variant="outline"
              onClick={() => {
                window.sessionStorage.removeItem(adminStorageKey);
                setAdminToken("");
                queryClient.removeQueries({ queryKey: ["admin-overview"] });
              }}
            >
              Log out
            </Button>
            <Button variant="outline" onClick={() => { window.location.pathname = "/"; }}>
              Open player
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !sessionRows.length}
              onClick={() => {
                if (window.confirm("Wipe every session and every uploaded music file?")) {
                  wipeMutation.mutate();
                }
              }}
            >
              {wipeMutation.isPending ? "Wiping everything..." : "Wipe all"}
            </Button>
          </div>
        </CardHeader>
        {errorMessage ? <CardContent><p className="text-sm text-destructive">{errorMessage}</p></CardContent> : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Sessions</CardDescription>
            <CardTitle>{overview?.summary.sessionCount ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Uploaded music</CardDescription>
            <CardTitle>{overview?.summary.trackCount ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Assets</CardDescription>
            <CardTitle>{overview?.summary.assetCount ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Live sessions</CardTitle>
            <CardDescription>{sessionRows.length} room(s)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sessionRows.length ? (
              sessionRows.map((session) => (
                <div key={session.sessionId} className="rounded-md border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-medium text-foreground">{session.sessionName}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{session.sessionId}</div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline">{session.memberCount} member(s)</Badge>
                        <Badge variant="outline">{session.trackCount} track(s)</Badge>
                        <Badge variant="outline">{session.playbackStatus}</Badge>
                      </div>
                      <div className="mt-3 text-sm text-muted-foreground">Current track: {session.currentTrackTitle ?? "none"}</div>
                    </div>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete session "${session.sessionName}"?`)) {
                          deleteSessionMutation.mutate(session.sessionId);
                        }
                      }}
                    >
                      Delete session
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground">
                No sessions exist right now.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Uploaded music</CardTitle>
            <CardDescription>{trackRows.length} track(s)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {trackRows.length ? (
              trackRows.map((track) => (
                <div key={track.trackId} className="rounded-md border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-lg font-medium text-foreground">{track.displayTitle}</div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {track.sessionName} • {track.mimeType ?? "unknown"} • {track.codec ?? "unknown codec"}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {track.sampleRate ? <Badge variant="outline">{track.sampleRate} Hz</Badge> : null}
                        {track.bitDepth ? <Badge variant="outline">{track.bitDepth}-bit</Badge> : null}
                        <Badge variant="outline">{formatDuration(track.durationMs)}</Badge>
                        <Badge variant="outline">{track.assetCount} asset(s)</Badge>
                      </div>
                      <div className="mt-3 text-xs text-muted-foreground">{track.trackId}</div>
                    </div>
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Delete "${track.displayTitle}" from all players now?`)) {
                          deleteTrackMutation.mutate(track.trackId);
                        }
                      }}
                    >
                      Delete music
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground">
                No uploaded music exists right now.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
