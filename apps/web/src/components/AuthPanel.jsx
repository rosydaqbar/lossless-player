import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createSession, fetchAvailableSessions, joinSession } from "../lib/api.js";
import { useSessionStore } from "../store/session-store.js";

function Field({ label, ...props }) {
  return (
    <label className="grid gap-2 text-sm">
      <span>{label}</span>
      <Input {...props} />
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
  const [activeTab, setActiveTab] = useState("create");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const searchParams = new URLSearchParams(window.location.search);
    const sessionFromQuery = searchParams.get("sessionId") ?? "";
    const accessCodeFromQuery = searchParams.get("accessCode") ?? "";
    const displayNameFromQuery = searchParams.get("displayName") ?? "";
    const shouldOpenJoin = Boolean(sessionFromQuery || accessCodeFromQuery || searchParams.get("upload") === "1");

    if (sessionFromQuery) {
      setSelectedSessionId(sessionFromQuery);
    }

    if (displayNameFromQuery) {
      setJoinForm((current) => ({ ...current, displayName: displayNameFromQuery }));
      setCreateForm((current) => ({ ...current, displayName: displayNameFromQuery }));
    }

    if (accessCodeFromQuery) {
      setJoinForm((current) => ({ ...current, accessCode: accessCodeFromQuery }));
    }

    if (shouldOpenJoin) {
      setActiveTab("join");
    }
  }, []);

  const sessionsQuery = useQuery({
    queryKey: ["available-sessions"],
    queryFn: fetchAvailableSessions,
    refetchInterval: 5000,
    refetchOnMount: "always",
    staleTime: 0
  });

  useEffect(() => {
    if (!sessionsQuery.data?.length) {
      if (selectedSessionId) setSelectedSessionId("");
      return;
    }
    const stillExists = sessionsQuery.data.some((session) => session.sessionId === selectedSessionId);
    if (!selectedSessionId || !stillExists) {
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
    <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6 py-12">
      <Card className="card-transition-in w-full max-w-xl">
        <CardHeader>
          <CardTitle>Lossless Listening Room</CardTitle>
          <CardDescription>Create a room or join an existing one.</CardDescription>
          {notice ? (
            <div className="text-sm text-destructive">
              {notice}{" "}
              <button className="underline" onClick={() => setNotice("")}>dismiss</button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="grid gap-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="create">Create room</TabsTrigger>
              <TabsTrigger value="join">Join room</TabsTrigger>
            </TabsList>

            <TabsContent value="create" className="grid gap-4 data-[state=active]:card-transition-in">
              <Field
                label="Your display name"
                value={createForm.displayName}
                placeholder="Hameng"
                onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
              />
              <Field
                label="Room name"
                value={createForm.sessionName}
                placeholder="Late Night Session"
                onChange={(event) => setCreateForm((current) => ({ ...current, sessionName: event.target.value }))}
              />
              <Button
                className="w-full"
                disabled={createMutation.isPending || !createForm.displayName.trim()}
                onClick={() => createMutation.mutate(createForm)}
              >
                {createMutation.isPending ? "Creating room..." : "Create shared room"}
              </Button>
              {createMutation.error ? <p className="text-sm text-destructive">{createMutation.error.message}</p> : null}
            </TabsContent>

            <TabsContent value="join" className="grid gap-4 data-[state=active]:card-transition-in">
              <div className="grid gap-2">
                <div className="text-sm text-muted-foreground">Available rooms</div>
                <div className="grid max-h-56 gap-2 overflow-y-auto">
                  {sessionsQuery.isLoading ? <div className="text-sm text-muted-foreground">Loading rooms...</div> : null}
                  {sessionsQuery.data?.map((session) => (
                    <Button
                      key={session.sessionId}
                      variant={selectedSessionId === session.sessionId ? "secondary" : "outline"}
                      className="h-auto justify-start py-2"
                      onClick={() => setSelectedSessionId(session.sessionId)}
                    >
                      <div className="font-medium">{session.sessionName}</div>
                      <div className="text-xs text-muted-foreground">Owner {session.ownerDisplayName}</div>
                    </Button>
                  ))}
                </div>
              </div>
              <Field
                label="Your display name"
                value={joinForm.displayName}
                placeholder="Listener name"
                onChange={(event) => setJoinForm((current) => ({ ...current, displayName: event.target.value }))}
              />
              <Field
                label="Access code"
                value={joinForm.accessCode}
                placeholder="listen-xxxxxx or ctrl-xxxxxx"
                onChange={(event) => setJoinForm((current) => ({ ...current, accessCode: event.target.value }))}
              />
              <Button
                className="w-full"
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
              </Button>
              {joinMutation.error ? <p className="text-sm text-destructive">{joinMutation.error.message}</p> : null}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
