import * as Tabs from "@radix-ui/react-tabs";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createSession, fetchAvailableSessions, joinSession } from "../lib/api.js";
import { useSessionStore } from "../store/session-store.js";

function FormField({ label, ...props }) {
  return (
    <label className="flex flex-col gap-2 text-sm text-zinc-200">
      <span>{label}</span>
      <input
        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400"
        {...props}
      />
    </label>
  );
}

export function AuthPanel() {
  const setSession = useSessionStore((state) => state.setSession);
  const notice = useSessionStore((state) => state.notice);
  const setNotice = useSessionStore((state) => state.setNotice);
  const [createForm, setCreateForm] = useState({
    displayName: "",
    sessionName: "Shared Listening Room"
  });
  const [joinForm, setJoinForm] = useState({
    displayName: "",
    accessCode: ""
  });
  const [selectedSessionId, setSelectedSessionId] = useState("");

  const sessionsQuery = useQuery({
    queryKey: ["available-sessions"],
    queryFn: fetchAvailableSessions,
    refetchInterval: 5000
  });

  useEffect(() => {
    if (!sessionsQuery.data?.length) {
      if (selectedSessionId) {
        setSelectedSessionId("");
      }
      return;
    }

    const sessionStillExists = sessionsQuery.data.some((session) => session.sessionId === selectedSessionId);
    if (!selectedSessionId || !sessionStillExists) {
      setSelectedSessionId(sessionsQuery.data[0].sessionId);
    }
  }, [selectedSessionId, sessionsQuery.data]);

  const createMutation = useMutation({
    mutationFn: createSession,
    onSuccess(data) {
      setSession({
        sessionId: data.state.sessionId,
        accessToken: data.accessToken,
        displayName: data.state.currentMember.displayName,
        audioArmed: false
      });
    }
  });

  const joinMutation = useMutation({
    mutationFn: ({ sessionId, input }) => joinSession(sessionId, input),
    onSuccess(data) {
      setSession({
        sessionId: data.state.sessionId,
        accessToken: data.accessToken,
        displayName: data.state.currentMember.displayName,
        audioArmed: false
      });
    }
  });

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-6 py-12">
      <div className="grid w-full gap-10 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <div className="inline-flex rounded-full border border-sky-400/20 bg-sky-400/10 px-4 py-1 text-xs uppercase tracking-[0.3em] text-sky-200">
            Shared Lossless Playback
          </div>
          {notice ? (
            <div className="max-w-2xl rounded-[1.5rem] border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
              <div className="font-medium">Playback error</div>
              <div className="mt-2">{notice}</div>
              <button
                className="mt-3 rounded-xl border border-rose-300/20 px-3 py-2 text-xs text-rose-50 hover:bg-white/5"
                onClick={() => setNotice("")}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="space-y-4">
            <h1 className="max-w-3xl text-5xl font-semibold tracking-tight text-white sm:text-6xl">
              Listen together with one queue, one transport, and room-level controller access.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-zinc-300">
              Upload local files, share a room ID with friends, and keep everyone synced to the same
              playback state. MP3 and FLAC are ready first, with server-side normalization prepared
              for ALAC, DSD, and other high-resolution formats.
            </p>
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-black/30 p-6 shadow-2xl shadow-black/40 backdrop-blur">
          <Tabs.Root defaultValue="create" className="space-y-6">
            <Tabs.List className="grid grid-cols-2 rounded-2xl border border-white/10 bg-white/5 p-1">
              <Tabs.Trigger
                value="create"
                className="rounded-xl px-4 py-3 text-sm text-zinc-300 data-[state=active]:bg-white data-[state=active]:text-zinc-950"
              >
                Create room
              </Tabs.Trigger>
              <Tabs.Trigger
                value="join"
                className="rounded-xl px-4 py-3 text-sm text-zinc-300 data-[state=active]:bg-white data-[state=active]:text-zinc-950"
              >
                Join room
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="create" className="space-y-4">
              <FormField
                label="Your display name"
                value={createForm.displayName}
                placeholder="Hameng"
                onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
              />
              <FormField
                label="Room name"
                value={createForm.sessionName}
                placeholder="Late Night Session"
                onChange={(event) => setCreateForm((current) => ({ ...current, sessionName: event.target.value }))}
              />
              <button
                className="w-full rounded-2xl bg-sky-400 px-4 py-3 text-sm font-medium text-zinc-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-zinc-600"
                disabled={createMutation.isPending || !createForm.displayName.trim()}
                onClick={() => createMutation.mutate(createForm)}
              >
                {createMutation.isPending ? "Creating room..." : "Create shared room"}
              </button>
              {createMutation.error ? (
                <p className="text-sm text-rose-300">{createMutation.error.message}</p>
              ) : null}
            </Tabs.Content>

            <Tabs.Content value="join" className="space-y-4">
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium text-white">Available rooms</div>
                  <div className="mt-1 text-sm text-zinc-400">Pick a room, then enter your name and access code.</div>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {sessionsQuery.isLoading ? (
                    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4 text-sm text-zinc-400">
                      Loading rooms...
                    </div>
                  ) : null}
                  {sessionsQuery.data?.map((session) => (
                    <button
                      key={session.sessionId}
                      className={`w-full rounded-[1.5rem] border px-4 py-4 text-left transition ${
                        selectedSessionId === session.sessionId
                          ? "border-sky-400/60 bg-sky-400/[0.12]"
                          : "border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.06]"
                      }`}
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-base font-medium text-white">{session.sessionName}</div>
                          <div className="mt-1 text-sm text-zinc-400">Owner {session.ownerDisplayName}</div>
                        </div>
                        {selectedSessionId === session.sessionId ? (
                          <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-sky-100">
                            Selected
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {session.memberCount} member{session.memberCount === 1 ? "" : "s"}
                        </span>
                        <span className="rounded-full border border-white/10 px-2 py-1">
                          {session.trackCount} track{session.trackCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    </button>
                  ))}
                  {sessionsQuery.isLoading || sessionsQuery.data?.length ? null : (
                    <div className="rounded-[1.5rem] border border-white/10 bg-white/5 px-4 py-4 text-sm text-zinc-400">
                      No rooms are available right now.
                    </div>
                  )}
                </div>
              </div>
              <FormField
                label="Your display name"
                value={joinForm.displayName}
                placeholder="Listener name"
                onChange={(event) => setJoinForm((current) => ({ ...current, displayName: event.target.value }))}
              />
              <FormField
                label="Access code"
                value={joinForm.accessCode}
                placeholder="listen-xxxxxx or ctrl-xxxxxx"
                onChange={(event) => setJoinForm((current) => ({ ...current, accessCode: event.target.value }))}
              />
              <button
                className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-medium text-zinc-950 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-600"
                disabled={joinMutation.isPending || !selectedSessionId || !joinForm.displayName.trim() || !joinForm.accessCode.trim()}
                onClick={() =>
                  joinMutation.mutate({
                    sessionId: selectedSessionId,
                    input: {
                      displayName: joinForm.displayName,
                      accessCode: joinForm.accessCode
                    }
                  })
                }
              >
                {joinMutation.isPending ? "Joining..." : "Join selected room"}
              </button>
              {joinMutation.error ? (
                <p className="text-sm text-rose-300">{joinMutation.error.message}</p>
              ) : null}
            </Tabs.Content>
          </Tabs.Root>
        </div>
      </div>
    </div>
  );
}
