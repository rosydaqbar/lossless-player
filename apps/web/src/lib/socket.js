import { io } from "socket.io-client";
import { getApiUrl } from "./api.js";

export function createSessionSocket() {
  return io(getApiUrl());
}
