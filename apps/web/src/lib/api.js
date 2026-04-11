function resolveApiUrl() {
  const explicitApiUrl = import.meta.env.VITE_API_URL;

  if (typeof window === "undefined") {
    return explicitApiUrl ?? "http://localhost:4000";
  }

  const pageProtocol = window.location.protocol === "https:" ? "https:" : "http:";
  const pageHostname = window.location.hostname;
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!explicitApiUrl) {
    return `${pageProtocol}//${pageHostname}:4000`;
  }

  try {
    const resolvedUrl = new URL(explicitApiUrl, window.location.origin);
    const apiIsLoopback = loopbackHosts.has(resolvedUrl.hostname);
    const pageIsLoopback = loopbackHosts.has(pageHostname);

    if (apiIsLoopback && !pageIsLoopback) {
      resolvedUrl.hostname = pageHostname;
    }

    return resolvedUrl.toString().replace(/\/$/, "");
  } catch {
    return explicitApiUrl;
  }
}

const API_URL = resolveApiUrl();

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.message ?? "Request failed");
    error.status = response.status;
    throw error;
  }

  return payload;
}

export function getApiUrl() {
  return API_URL;
}

async function adminRequest(path, adminToken, options = {}) {
  const headers = {
    ...(options.headers ?? {}),
    Authorization: `Bearer ${adminToken}`
  };

  return request(path, {
    ...options,
    headers
  });
}

export async function createSession(input) {
  return request("/api/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function fetchAvailableSessions() {
  return request("/api/sessions");
}

export async function joinSession(sessionId, input) {
  return request(`/api/sessions/${sessionId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function fetchSessionState(sessionId, accessToken) {
  return request(`/api/sessions/${sessionId}/state`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function deleteSession(sessionId, accessToken) {
  return request(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function uploadTracks(sessionId, accessToken, files) {
  const uploads = [];

  for (const file of files) {
    const formData = new FormData();
    formData.append("file", file);
    const result = await request(`/api/sessions/${sessionId}/uploads`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        body: formData
      });
    uploads.push(result);
  }

  return uploads;
}

export async function mutateQueue(sessionId, accessToken, input) {
  return request(`/api/sessions/${sessionId}/queue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export async function controlPlayback(sessionId, accessToken, input) {
  return request(`/api/sessions/${sessionId}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export async function fetchSessionBots(sessionId, accessToken) {
  return request(`/api/sessions/${sessionId}/bots`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function connectSessionBot(sessionId, botId, accessToken) {
  return request(`/api/sessions/${sessionId}/bots/${botId}/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({})
  });
}

export async function disconnectSessionBot(sessionId, botId, accessToken) {
  return request(`/api/sessions/${sessionId}/bots/${botId}/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({})
  });
}

export async function updateMemberRole(sessionId, memberId, accessToken, input) {
  return request(`/api/sessions/${sessionId}/members/${memberId}/role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export async function resolveTrackAsset(sessionId, trackId, accessToken, capabilities) {
  const searchParams = new URLSearchParams({
    sessionId,
    supportsFlac: String(capabilities.supportsFlac),
    supportsMp3: String(capabilities.supportsMp3),
    supportsWav: String(capabilities.supportsWav),
    supportsAiff: String(capabilities.supportsAiff),
    supportsMseFlacSegmented: String(capabilities.supportsMseFlacSegmented),
    mimeTypes: capabilities.mimeTypes.join(",")
  });

  return request(`/api/tracks/${trackId}/asset?${searchParams.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function adminLogin(password) {
  return request("/api/admin/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "admin",
      password
    })
  });
}

export async function fetchAdminOverview(adminToken) {
  return adminRequest("/api/admin/overview", adminToken);
}

export async function adminDeleteSession(adminToken, sessionId) {
  return adminRequest(`/api/admin/sessions/${sessionId}`, adminToken, {
    method: "DELETE"
  });
}

export async function adminDeleteTrack(adminToken, trackId) {
  return adminRequest(`/api/admin/tracks/${trackId}`, adminToken, {
    method: "DELETE"
  });
}

export async function adminWipeAll(adminToken) {
  return adminRequest("/api/admin/wipe", adminToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
}
