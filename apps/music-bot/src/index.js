import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { loadConfig, getMissingRequiredConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { controlPlayback, getSessionState, joinSession } from "./player-client.js";
import {
  buildStatusMessagePayload,
  getButtonIds,
  getMessageHash,
  getPlayPauseAction
} from "./status-message.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../../");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

function buildCommands() {
  return [
    new SlashCommandBuilder().setName("ping").setDescription("Bot heartbeat check"),
    new SlashCommandBuilder().setName("bot-status").setDescription("Show bot runtime status"),
    new SlashCommandBuilder()
      .setName("connect")
      .setDescription("Connect the bot to one session")
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription("Session ID")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("code")
          .setDescription("Listener or controller code")
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName("disconnect").setDescription("Disconnect from current session"),
    new SlashCommandBuilder().setName("status").setDescription("Fetch latest player state summary"),
    new SlashCommandBuilder()
      .setName("refresh-message")
      .setDescription("Force refresh the persistent now-playing message")
  ].map((command) => command.toJSON());
}

function isSessionNotFoundError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.status === 404 || message.includes("session not found");
}

function isUnauthorizedError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.status === 401 || message.includes("unauthorized");
}

function isInteractionAlreadyAcknowledgedError(error) {
  return error?.code === 40060;
}

function isUnknownInteractionError(error) {
  return error?.code === 10062;
}

function isControllerRole(role) {
  return role === "owner" || role === "controller";
}

class MusicBot {
  constructor(config) {
    this.config = config;
    this.stateStore = new StateStore(config.stateFile, config.legacyStateFile);
    this.buttonIds = getButtonIds();
    this.syncTimer = null;
    this.syncFailures = 0;
    this.lastStickyMoveAt = 0;
    this.controlServer = null;

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });
  }

  async start() {
    await this.stateStore.load();
    this.state = await this.stateStore.clear();

    this.client.once(Events.ClientReady, async () => {
      console.log(`[music-bot] logged in as ${this.client.user.tag}`);
      await this.registerSlashCommands();
      try {
        await this.startControlServer();
      } catch (error) {
        if (error?.code === "EADDRINUSE") {
          console.warn(
            `[music-bot] control server port ${this.config.botControlPort} already in use. Another bot instance is active; exiting this process.`
          );
          this.client.destroy();
          return;
        } else {
          throw error;
        }
      }
      console.log("[music-bot] waiting for web connect");
      this.startSyncLoop();
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await this.handleCommand(interaction);
        } else if (interaction.isButton()) {
          await this.handleButton(interaction);
        }
      } catch (error) {
        if (isInteractionAlreadyAcknowledgedError(error)) {
          return;
        }

        if (isUnknownInteractionError(error)) {
          return;
        }

        if (isUnauthorizedError(error)) {
          await this.replyEphemeral(interaction, "Bot session expired or is invalid. Use /connect again.");
          return;
        }

        console.error("[music-bot] interaction error", error);
        if (interaction.isRepliable()) {
          await this.replyEphemeral(interaction, `Error: ${error?.message ?? "Unexpected failure"}`);
        }
      }
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (!this.isConnected()) {
        return;
      }

      if (message.channelId !== this.state.channelId) {
        return;
      }

      if (message.id === this.state.messageId) {
        return;
      }

      if (message.author?.id === this.client.user?.id) {
        return;
      }

      try {
        await this.ensureStickyAtBottom(`message:${message.id}`);
      } catch (error) {
        console.warn("[music-bot] sticky move failed", error?.message ?? error);
      }
    });

    await this.client.login(this.config.discordToken);
  }

  async replyEphemeral(interaction, content) {
    if (!interaction?.isRepliable?.()) {
      return;
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  async startControlServer() {
    if (this.controlServer) {
      return;
    }

    const server = createServer(async (req, res) => {
      try {
        if (this.config.botControlToken) {
          const provided = String(req.headers["x-bot-control-token"] ?? "");
          if (provided !== this.config.botControlToken) {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ message: "Unauthorized bot control request" }));
            return;
          }
        }

        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";

        if (method === "GET" && requestUrl.pathname === "/internal/bots") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ bots: [this.getBotStatus()] }));
          return;
        }

        const botPathMatch = requestUrl.pathname.match(/^\/internal\/bots\/([^/]+)(?:\/(connect|disconnect))?$/);
        if (!botPathMatch) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: "Not found" }));
          return;
        }

        const [, botId, action] = botPathMatch;
        if (botId !== this.config.botId) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ message: "Unknown bot" }));
          return;
        }

        if (!action && method === "GET") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(this.getBotStatus()));
          return;
        }

        const rawBody = await new Promise((resolve) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        const body = rawBody ? JSON.parse(rawBody) : {};

        if (action === "connect" && method === "POST") {
          const sessionId = String(body.sessionId ?? "").trim();
          const accessToken = String(body.accessToken ?? "").trim();
          const channelId = String(body.channelId ?? "").trim();
          if (!sessionId || !accessToken) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ message: "sessionId and accessToken are required" }));
            return;
          }

          const connectedState = await this.connectToSession({ sessionId, accessToken, channelId });
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            bot: this.getBotStatus(),
            state: connectedState
          }));
          return;
        }

        if (action === "disconnect" && method === "POST") {
          if (this.state.messageId && this.state.channelId) {
            try {
              const channel = await this.getTargetChannel(this.state.channelId);
              await this.deleteMessageIfExists(channel, this.state.messageId);
            } catch {
              // ignore cleanup errors
            }
          }

          await this.stateStore.clear();
          this.state = this.stateStore.snapshot();
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ bot: this.getBotStatus() }));
          return;
        }

        res.statusCode = 405;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "Method not allowed" }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: error?.message ?? "Bot control failed" }));
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.botControlPort, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.controlServer = server;
    console.log(`[music-bot] control server listening on ${this.config.botControlPort}`);
  }

  getBotStatus() {
    const wsStatus = this.client.ws.status;
    const online = wsStatus === 0;
    return {
      botId: this.config.botId,
      name: this.config.botName,
      alive: Boolean(this.client.user),
      online,
      wsStatus,
      pingMs: this.client.ws.ping,
      user: this.client.user
        ? {
            id: this.client.user.id,
            username: this.client.user.username,
            discriminator: this.client.user.discriminator,
            tag: this.client.user.tag,
            avatarUrl: this.client.user.displayAvatarURL({ size: 128 })
          }
        : null,
      connectedSessionId: this.state.sessionId || null,
      channelId: this.state.channelId || null,
      messageId: this.state.messageId || null,
      connectedAt: this.state.connectedAt || null,
      waitingForConnect: !this.state.sessionId
    };
  }

  async registerSlashCommands() {
    const rest = new REST({ version: "10" }).setToken(this.config.discordToken);
    const commands = buildCommands();
    await rest.put(
      Routes.applicationGuildCommands(this.config.discordClientId, this.config.discordGuildId),
      { body: commands }
    );
    console.log("[music-bot] slash commands registered");
  }

  isConnected() {
    return Boolean(this.state.sessionId && this.state.accessToken && this.state.channelId);
  }

  async resumeConnection() {
    if (!this.isConnected()) {
      return;
    }

    try {
      const currentState = await this.fetchPlayerState();
      await this.renderStatusMessage(currentState, { force: true });
      console.log(`[music-bot] resumed session ${this.state.sessionId}`);
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        console.warn("[music-bot] saved session not found, resetting bot session state");
        await this.stateStore.clear();
        this.state = this.stateStore.snapshot();
        return;
      }

      console.warn("[music-bot] failed to resume saved connection", error?.message);
    }
  }

  startSyncLoop() {
    const tick = async () => {
      if (!this.isConnected()) {
        this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
        return;
      }

      try {
        const currentState = await this.fetchPlayerState();
        await this.renderStatusMessage(currentState, { force: false });
        this.syncFailures = 0;
      } catch (error) {
        if (String(error?.message ?? "").includes("Bot session expired")) {
          console.warn("[music-bot] session expired; resetting to waiting state");
          await this.stateStore.clear();
          this.state = this.stateStore.snapshot();
          this.syncFailures = 0;
          this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
          return;
        }

        if (isUnauthorizedError(error)) {
          console.warn("[music-bot] sync failed unauthorized");
          this.syncFailures = 0;
          this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
          return;
        }

        if (isSessionNotFoundError(error)) {
          console.warn("[music-bot] connected session not found during sync, resetting bot session state");
          await this.stateStore.clear();
          this.state = this.stateStore.snapshot();
          this.syncFailures = 0;
          this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
          return;
        }

        this.syncFailures += 1;
        console.warn("[music-bot] sync failed", error?.message ?? error);
      }

      const backoffMultiplier = Math.min(8, 2 ** this.syncFailures);
      const nextDelay = this.config.syncIntervalMs * backoffMultiplier;
      this.syncTimer = setTimeout(tick, nextDelay);
    };

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
  }

  async fetchPlayerState() {
    try {
      return await getSessionState(this.config.playerApiBaseUrl, this.state.sessionId, this.state.accessToken);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }

      const recoveredState = await this.refreshSessionToken();
      if (recoveredState) {
        return recoveredState;
      }

      throw error;
    }
  }

  async refreshSessionToken() {
    if (!this.state.sessionId || !this.state.sessionAccessCode) {
      throw new Error("Bot session expired. Reconnect using /connect.");
    }

    try {
      const joined = await joinSession(
        this.config.playerApiBaseUrl,
        this.state.sessionId,
        this.state.sessionAccessCode,
        this.config.botDisplayName
      );

      this.state = await this.stateStore.patch({
        accessToken: joined.accessToken,
        connectedAt: new Date().toISOString()
      });

      console.log(`[music-bot] refreshed access token for session ${this.state.sessionId}`);
      return joined.state;
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        await this.stateStore.clear();
        this.state = this.stateStore.snapshot();
      }

      throw error;
    }
  }

  getCurrentTrack(state) {
    if (!state?.queue?.length) {
      return null;
    }

    const byTransport = state.queue.find((item) => item.trackId === state.transport.trackId)?.track;
    if (byTransport) {
      return byTransport;
    }

    const bySelected = state.queue.find((item) => item.isSelected)?.track;
    return bySelected ?? state.queue[0].track;
  }

  inferArtworkExtension(contentType) {
    const normalized = String(contentType ?? "").toLowerCase();
    if (normalized.includes("image/jpeg") || normalized.includes("image/jpg")) {
      return ".jpg";
    }
    if (normalized.includes("image/png")) {
      return ".png";
    }
    if (normalized.includes("image/webp")) {
      return ".webp";
    }
    if (normalized.includes("image/gif")) {
      return ".gif";
    }
    return ".img";
  }

  async buildArtworkAttachment(state) {
    const track = this.getCurrentTrack(state);
    const artworkAsset = track?.assets?.find((asset) => asset.kind === "artwork" && asset.assetId);
    if (!track?.trackId || !artworkAsset?.assetId) {
      return null;
    }

    const query = new URLSearchParams({
      sessionId: state.sessionId,
      accessToken: this.state.accessToken
    });
    const url = `${this.config.playerApiBaseUrl}/api/tracks/${track.trackId}/stream/${artworkAsset.assetId}?${query.toString()}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return null;
      }

      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      if (!contentType.startsWith("image/")) {
        return null;
      }

      const extension = this.inferArtworkExtension(contentType);
      const filename = `cover-${track.trackId}${extension}`;
      const bytes = Buffer.from(await response.arrayBuffer());

      return {
        file: new AttachmentBuilder(bytes, { name: filename }),
        filename
      };
    } catch {
      return null;
    }
  }

  async getTargetChannel(channelIdOverride = "") {
    const resolvedChannelId = channelIdOverride || this.state.channelId || this.config.defaultChannelId;
    if (!resolvedChannelId) {
      throw new Error("No channel selected. Use /connect inside a channel.");
    }

    const channel = await this.client.channels.fetch(resolvedChannelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error("Target channel is not a text channel.");
    }

    return channel;
  }

  async editOrCreateMessage(payload) {
    const channel = await this.getTargetChannel();

    if (this.state.messageId) {
      try {
        const existing = await channel.messages.fetch(this.state.messageId);
        await existing.edit(payload);
        return existing;
      } catch {
        // fall through and recreate once
      }
    }

    const created = await channel.send(payload);
    this.state = await this.stateStore.patch({ messageId: created.id, channelId: channel.id });
    return created;
  }

  async deleteMessageIfExists(channel, messageId) {
    if (!messageId) {
      return;
    }

    try {
      const target = await channel.messages.fetch(messageId);
      await target.delete();
    } catch {
      // message can already be gone
    }
  }

  async moveStatusMessageToBottom(state, reason) {
    const channel = await this.getTargetChannel();
    const artwork = await this.buildArtworkAttachment(state);
    const payload = buildStatusMessagePayload(state, this.config, this.state, {
      artworkAttachmentName: artwork?.filename ?? ""
    });
    const previousMessageId = this.state.messageId;
    const created = await channel.send({
      ...payload,
      files: artwork ? [artwork.file] : []
    });

    this.state = await this.stateStore.patch({
      messageId: created.id,
      channelId: channel.id,
      lastStateHash: getMessageHash(state)
    });

    await this.deleteMessageIfExists(channel, previousMessageId);
    this.lastStickyMoveAt = Date.now();
    console.log(
      `[music-bot] sticky moved to bottom reason=${reason} oldMessageId=${previousMessageId || "none"} newMessageId=${created.id}`
    );
    return created;
  }

  async ensureStickyAtBottom(reason) {
    if (!this.isConnected()) {
      return false;
    }

    if (Date.now() - this.lastStickyMoveAt < 1000) {
      return false;
    }

    const channel = await this.getTargetChannel();
    const latestMessages = await channel.messages.fetch({ limit: 1 });
    const latestMessage = latestMessages.first();

    if (!latestMessage || latestMessage.id === this.state.messageId) {
      return false;
    }

    const currentState = await this.fetchPlayerState();
    await this.moveStatusMessageToBottom(currentState, reason);
    return true;
  }

  async renderStatusMessage(state, { force }) {
    const nextHash = getMessageHash(state);
    if (!force && nextHash === this.state.lastStateHash) {
      return false;
    }

    const artwork = await this.buildArtworkAttachment(state);
    const payload = buildStatusMessagePayload(state, this.config, this.state, {
      artworkAttachmentName: artwork?.filename ?? ""
    });
    const messagePayload = {
      ...payload,
      files: artwork ? [artwork.file] : []
    };
    await this.editOrCreateMessage(messagePayload);
    this.state = await this.stateStore.patch({ lastStateHash: nextHash });

    await this.ensureStickyAtBottom("state-update");
    return true;
  }

  async connectToSession({ sessionId, accessCode = "", accessToken = "", channelId = "" }) {
    let joinResult;
    if (accessCode) {
      joinResult = await joinSession(
        this.config.playerApiBaseUrl,
        sessionId,
        accessCode,
        this.config.botDisplayName
      );
    } else {
      const state = await getSessionState(this.config.playerApiBaseUrl, sessionId, accessToken);
      joinResult = {
        accessToken,
        state
      };
    }

    this.state = await this.stateStore.patch({
      sessionId,
      accessToken: joinResult.accessToken,
      sessionAccessCode: accessCode,
      channelId: channelId || this.config.defaultChannelId,
      connectedAt: new Date().toISOString(),
      messageId: "",
      lastStateHash: ""
    });

    await this.renderStatusMessage(joinResult.state, { force: true });
    return joinResult.state;
  }

  async sendStatusSummary(interaction) {
    if (!this.isConnected()) {
      await interaction.reply({ content: "Bot is not connected to any session.", flags: MessageFlags.Ephemeral });
      return;
    }

    const currentState = await this.fetchPlayerState();
    const action = getPlayPauseAction(currentState);

    await interaction.reply({
      content: [
        `Connected session: ${this.state.sessionId}`,
        `Channel: <#${this.state.channelId}>`,
        `Transport: ${currentState.transport.status}`,
        `Role: ${currentState.currentMember?.role ?? "listener"}`,
        `Next play/pause action: ${action}`,
        `Queue length: ${currentState.queue.length}`
      ].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  }

  computeTransportPositionMs(transport) {
    const base = Math.max(0, Number(transport?.basePositionMs ?? 0));
    if (!transport || transport.status !== "playing") {
      return base;
    }

    const effectiveAtMs = Number(transport.effectiveAtMs ?? 0);
    if (!Number.isFinite(effectiveAtMs) || effectiveAtMs <= 0) {
      return base;
    }

    return Math.max(0, Math.round(base + Math.max(0, Date.now() - effectiveAtMs)));
  }

  getCurrentTrackFromState(state) {
    if (!state?.queue?.length) {
      return null;
    }

    const byTransport = state.queue.find((item) => item.trackId === state.transport.trackId)?.track;
    if (byTransport) {
      return byTransport;
    }

    const bySelected = state.queue.find((item) => item.isSelected)?.track;
    return bySelected ?? state.queue[0].track;
  }

  computePausePositionMs(state) {
    const rawPosition = this.computeTransportPositionMs(state.transport);
    const durationMs = Number(this.getCurrentTrackFromState(state)?.durationMs ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return rawPosition;
    }

    return Math.max(0, Math.min(rawPosition, Math.max(0, durationMs - 250)));
  }

  async controlWithRetry(action, state) {
    const payload = {
      action,
      revision: state.transport.revision
    };

    if (action === "pause") {
      payload.positionMs = this.computePausePositionMs(state);
    }

    try {
      const result = await controlPlayback(
        this.config.playerApiBaseUrl,
        this.state.sessionId,
        this.state.accessToken,
        payload,
        this.config.botControlBypassToken
      );
      return result.state;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        const recoveredState = await this.refreshSessionToken();
        const retryAfterRefresh = {
          action,
          revision: recoveredState.transport.revision
        };

        if (action === "pause") {
          retryAfterRefresh.positionMs = this.computePausePositionMs(recoveredState);
        }

        const retry = await controlPlayback(
          this.config.playerApiBaseUrl,
          this.state.sessionId,
          this.state.accessToken,
          retryAfterRefresh,
          this.config.botControlBypassToken
        );
        return retry.state;
      }

      if (error?.status !== 409) {
        throw error;
      }

      const refreshed = await this.fetchPlayerState();
      const retryPayload = {
        action,
        revision: refreshed.transport.revision
      };

      if (action === "pause") {
        retryPayload.positionMs = this.computePausePositionMs(refreshed);
      }

      const retry = await controlPlayback(
        this.config.playerApiBaseUrl,
        this.state.sessionId,
        this.state.accessToken,
        retryPayload,
        this.config.botControlBypassToken
      );
      return retry.state;
    }
  }

  resolveButtonAction(customId, state) {
    if (customId === this.buttonIds.previous) {
      return "previous";
    }
    if (customId === this.buttonIds.play) {
      return "play";
    }
    if (customId === this.buttonIds.pause) {
      return "pause";
    }
    if (customId === this.buttonIds.stop) {
      return "stop";
    }
    if (customId === this.buttonIds.next) {
      return "next";
    }
    if (customId === this.buttonIds.playPause) {
      return getPlayPauseAction(state);
    }
    return "";
  }

  async handleButton(interaction) {
    try {
      await interaction.deferUpdate();
    } catch (error) {
      if (isUnknownInteractionError(error) || isInteractionAlreadyAcknowledgedError(error)) {
        return;
      }
      throw error;
    }

    if (!this.isConnected()) {
      await this.replyEphemeral(interaction, "Bot is not connected to a session.");
      return;
    }

    const currentState = await this.fetchPlayerState();
    const action = this.resolveButtonAction(interaction.customId, currentState);
    console.log(
      `[music-bot] button pressed customId=${interaction.customId} resolvedAction=${action || "none"} transportStatus=${currentState.transport.status}`
    );
    if (!action) {
      await this.replyEphemeral(interaction, "Unsupported button action.");
      return;
    }

    const nextState = await this.controlWithRetry(action, currentState);
    console.log(
      `[music-bot] control result action=${action} status=${nextState.transport.status} trackId=${nextState.transport.trackId ?? "none"}`
    );
    await this.renderStatusMessage(nextState, { force: true });
  }

  async handleCommand(interaction) {
    if (interaction.commandName === "ping") {
      await interaction.reply({ content: "pong", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "bot-status") {
      await interaction.reply({
        content: [
          `Logged in as: ${this.client.user?.tag ?? "unknown"}`,
          `Connected: ${this.isConnected() ? "yes" : "no"}`,
          `Session ID: ${this.state.sessionId || "none"}`,
          `Channel ID: ${this.state.channelId || "none"}`,
          `Message ID: ${this.state.messageId || "none"}`
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "connect") {
      const sessionId = interaction.options.getString("session", true).trim();
      const accessCode = interaction.options.getString("code", true).trim();
      const channelId = interaction.channelId;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const state = await this.connectToSession({ sessionId, accessCode, channelId });
      await interaction.editReply(
        `Connected to session **${state.sessionName}** (${state.sessionId}) as **${state.currentMember.role}** and bound status message to <#${channelId}>.`
      );
      return;
    }

    if (interaction.commandName === "disconnect") {
      await this.stateStore.clear();
      this.state = this.stateStore.snapshot();
      await interaction.reply({ content: "Disconnected bot from player session.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "status") {
      await this.sendStatusSummary(interaction);
      return;
    }

    if (interaction.commandName === "refresh-message") {
      if (!this.isConnected()) {
        await interaction.reply({ content: "Bot is not connected to any session.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const currentState = await this.fetchPlayerState();
      await this.renderStatusMessage(currentState, { force: true });
      await interaction.editReply("Status message refreshed.");
    }
  }
}

async function bootstrap() {
  const config = loadConfig();
  const missing = getMissingRequiredConfig(config);

  if (missing.length) {
    console.log(`[music-bot] not started. Missing env: ${missing.join(", ")}`);
    console.log("[music-bot] set env vars and run again.");
    return;
  }

  const bot = new MusicBot(config);
  await bot.start();
}

bootstrap().catch((error) => {
  console.error("[music-bot] fatal startup error", error);
  process.exitCode = 1;
});
