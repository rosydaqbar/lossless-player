# Discord Music Bot Implementation Plan

## Goal

Build a Discord bot (JavaScript) that connects to a single lossless-player session, posts one persistent now-playing message in a Discord channel, updates that same message for all state changes, and supports playback control actions from Discord.

This implementation will use Discord Components v2 (not legacy components).

---

## Current System Facts

- Existing API supports:
  - `POST /api/sessions/:id/join`
  - `GET /api/sessions/:id/state`
  - `POST /api/sessions/:id/control`
- Playback control currently supports: `play`, `pause`, `stop`, `next`, `previous`, `seek`.
- Playback control authorization currently requires `owner` or `controller` role.
- Room/session state already contains useful track quality fields (`codec`, `sampleRate`, `bitDepth`, `channels`, etc.).

---

## Phased Implementation (Testable Increments)

## Phase 1 - Bot Scaffold (No Session Integration)

### Scope

- Create `apps/music-bot` (JavaScript, ESM).
- Add startup entrypoint and env loading.
- Add Discord login flow.
- Add slash command registration skeleton.
- Add basic commands:
  - `/ping`
  - `/bot-status`

### Test Criteria

- Bot starts and logs in successfully.
- Commands are visible in guild.
- `/ping` returns a response.

---

## Phase 2 - Session Connection Command

### Scope

- Implement `/connect session:{id} code:{listener-or-controller-code}`.
- Bot calls `POST /api/sessions/:id/join` with bot display name + provided code.
- Persist connection state (single active session for now):
  - `sessionId`
  - `accessToken`
  - `channelId`
  - `messageId` (nullable initially)
  - `connectedAt`
- Store state in a local JSON file so restart does not lose linkage.

### Test Criteria

- `/connect` succeeds with valid session/code.
- Bot reconnects after restart using persisted state.

---

## Phase 3 - Persistent Now-Playing Message

### Scope

- On successful connect, create one status message in target channel (if not existing).
- On updates, edit by `messageId` only.
- Never create repeated status messages for normal state changes.
- If stored message is missing/deleted, recreate once and update stored `messageId`.

### Test Criteria

- Playback state changes always update the same message ID.
- Message survives bot restart via persisted `messageId`.

---

## Phase 4 - Session Sync Loop

### Scope

- Add polling engine against `GET /api/sessions/:id/state`.
- Poll interval configurable via env (default around 2s).
- Compute change hash and only edit Discord message when meaningful data changed.
- Add retry/backoff handling for transient API failures.

### Test Criteria

- Message updates quickly on state changes.
- No unnecessary edit spam when nothing changed.
- Bot recovers after temporary API outage.

---

## Phase 5 - Discord Components v2 UI

### Scope

- Render status message using Components v2 structures.
- Include track and quality details:
  - Title
  - Artist
  - Album
  - Status (idle/playing/paused)
  - Position / Duration
  - Codec / MIME
  - Sample Rate / Bit Depth / Channels
  - Playback mode
- Include buttons:
  - `Open Player` (link)
  - `Add Music` (link)
  - `Previous`
  - `Play/Pause`
  - `Stop`
  - `Next`

### Test Criteria

- Components render correctly.
- Buttons appear and are interactive.
- Message still updates via same message ID.

---

## Phase 6 - Playback Control from Discord

### Scope

- Wire button handlers to `POST /api/sessions/:id/control`.
- Supported actions:
  - `next`
  - `previous`
  - `stop`
  - `pause` / `play`
- Do not implement seek controls.
- Handle revision conflict (`409`) by refreshing state and retrying once.

### Test Criteria

- All supported controls execute successfully from Discord.
- UI reflects updated transport state after controls.

---

## Phase 7 - Add Music Deep Link (Upload Modal Auto-Open)

### Scope

- Add web support for query param trigger (e.g. `?upload=1`) to open upload modal automatically in `SessionRoom`.
- Build `Add Music` URL to open player and trigger upload modal immediately.
- Optional query prefill support for join flow.

### Test Criteria

- Clicking `Add Music` from Discord opens web app and immediately opens upload modal.

---

## Phase 8 - Volume Control (API + Bot)

### Scope

- Add room-level volume to backend contracts/state (currently not present).
- Add DB migration and API support for volume updates.
- Sync room volume to web playback service.
- Add Discord controls for volume up/down.

### Test Criteria

- Volume changes from Discord are reflected in active playback.
- Volume state remains consistent across clients.

---

## Command Set (Target)

- `/connect session:{id} code:{listener-or-controller-code}`
- `/disconnect`
- `/status`
- `/refresh-message`

Controls are via message buttons (not slash commands):

- Previous
- Play/Pause
- Stop
- Next
- Add Music (link)
- Open Player (link)

---

## Persistent Message Rules

- Exactly one active status message per bot session connection.
- All updates are message edits.
- Message ID stored in state file.
- On missing/deleted message, recreate and replace stored message ID.

---

## Proposed Environment Example (Music Bot)

```env
# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_DEFAULT_CHANNEL_ID=

# Lossless Player
PLAYER_API_BASE_URL=http://localhost:4000
PLAYER_WEB_BASE_URL=http://localhost:5173
BOT_DISPLAY_NAME=Discord Music Bot

# Runtime
STATE_FILE=./data/bot-state.json
SYNC_INTERVAL_MS=2000
LOG_LEVEL=info
```

---

## Notes / Constraints

- Single connected music-player session only (for now).
- Seek control is intentionally not exposed in Discord UI.
- Discord Components v2 must be used for status/control message.
- If connected with listener code, playback controls may fail due to current API role checks; controller/owner code is required for control with current backend policy.
