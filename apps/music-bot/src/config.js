import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredAtRuntime = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"];
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, "..");
const workspaceRoot = path.resolve(appRoot, "..", "..");

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const stateFile = env.STATE_FILE ?? "./apps/music-bot/data/bot-state.json";
  const resolvedStateFile = path.isAbsolute(stateFile) ? stateFile : path.resolve(workspaceRoot, stateFile);
  const legacyStateFile = path.isAbsolute(stateFile) ? "" : path.resolve(appRoot, stateFile);

  return {
    discordToken: env.DISCORD_BOT_TOKEN ?? "",
    discordClientId: env.DISCORD_CLIENT_ID ?? "",
    discordGuildId: env.DISCORD_GUILD_ID ?? "",
    defaultChannelId: env.DISCORD_DEFAULT_CHANNEL_ID ?? "",
    playerApiBaseUrl: (env.PLAYER_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, ""),
    playerWebBaseUrl: (env.PLAYER_WEB_BASE_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    botControlBypassToken: env.BOT_CONTROL_BYPASS_TOKEN ?? "",
    botControlPort: Math.max(1, parseInteger(env.BOT_CONTROL_PORT, 4100)),
    botControlToken: env.BOT_CONTROL_TOKEN ?? "",
    botId: env.BOT_ID ?? "discord-primary",
    botName: env.BOT_NAME ?? "Discord Music Bot",
    botDisplayName: env.BOT_DISPLAY_NAME ?? "Discord Music Bot",
    stateFile: resolvedStateFile,
    legacyStateFile,
    syncIntervalMs: Math.max(500, parseInteger(env.SYNC_INTERVAL_MS, 2000)),
    logLevel: env.LOG_LEVEL ?? "info"
  };
}

export function getMissingRequiredConfig(config) {
  const values = {
    DISCORD_BOT_TOKEN: config.discordToken,
    DISCORD_CLIENT_ID: config.discordClientId,
    DISCORD_GUILD_ID: config.discordGuildId
  };

  return requiredAtRuntime.filter((key) => !values[key]);
}
