import { create } from "zustand";

const storageKey = "lossless-player-session";

function readInitialState() {
  if (typeof window === "undefined") {
    return {
      sessionId: "",
      accessToken: "",
      displayName: "",
      audioArmed: false,
      notice: ""
    };
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return {
      sessionId: "",
      accessToken: "",
      displayName: "",
      audioArmed: false,
      notice: ""
    };
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      sessionId: "",
      accessToken: "",
      displayName: "",
      audioArmed: false,
      notice: ""
    };
  }
}

export const useSessionStore = create((set) => ({
  ...readInitialState(),
  setSession(payload) {
    set((state) => {
      const next = { ...state, ...payload, notice: "" };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  },
  clearSession(notice = "") {
    const next = {
      sessionId: "",
      accessToken: "",
      displayName: "",
      audioArmed: false,
      notice
    };
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    set(next);
  },
  setNotice(notice) {
    set((state) => {
      const next = { ...state, notice };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  },
  setAudioArmed(audioArmed) {
    set((state) => {
      const next = { ...state, audioArmed };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }
}));
