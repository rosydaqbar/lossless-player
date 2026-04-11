function buildError(status, message) {
  const error = new Error(message || "Request failed");
  error.status = status;
  return error;
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw buildError(response.status, payload.message);
  }

  return payload;
}

export function joinSession(baseUrl, sessionId, accessCode, displayName) {
  return request(baseUrl, `/api/sessions/${sessionId}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName,
      accessCode
    })
  });
}

export function getSessionState(baseUrl, sessionId, accessToken) {
  return request(baseUrl, `/api/sessions/${sessionId}/state`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function controlPlayback(baseUrl, sessionId, accessToken, payload, bypassToken = "") {
  return request(baseUrl, `/api/sessions/${sessionId}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "x-lossless-bot": "1",
      ...(bypassToken ? { "x-lossless-bot-token": bypassToken } : {})
    },
    body: JSON.stringify(payload)
  });
}
