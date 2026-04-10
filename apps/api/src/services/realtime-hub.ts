import type { SessionState } from "@lossless-player/contracts";
import type { Server } from "socket.io";

export class RealtimeHub {
  private io: Server | null = null;

  attach(io: Server) {
    this.io = io;
  }

  emitSessionState(sessionId: string, state: SessionState) {
    this.io?.to(this.roomName(sessionId)).emit("session:state", state);
  }

  emitTransportCommand(sessionId: string, payload: unknown) {
    this.io?.to(this.roomName(sessionId)).emit("transport:command", payload);
  }

  emitUploadStatus(sessionId: string, payload: unknown) {
    this.io?.to(this.roomName(sessionId)).emit("upload:status", payload);
  }

  emitSessionError(sessionId: string, payload: unknown) {
    this.io?.to(this.roomName(sessionId)).emit("session:error", payload);
  }

  roomName(sessionId: string) {
    return `session:${sessionId}`;
  }
}
