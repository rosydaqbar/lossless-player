import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const moduleDir = dirname(fileURLToPath(import.meta.url));
let apiRoot = resolve(moduleDir, "..", "..");
if (["src", "dist"].includes(basename(apiRoot))) {
  apiRoot = resolve(apiRoot, "..");
}
const workspaceRoot = resolve(apiRoot, "..", "..");

config({ path: resolve(workspaceRoot, ".env"), override: false });
config({ path: resolve(apiRoot, ".env"), override: true });

const envSchema = z.object({
  DATABASE_DRIVER: z.enum(["postgres", "pglite"]).default("pglite"),
  DATABASE_URL: z.string().min(1),
  PGLITE_DATA_DIR: z.string().default("memory://"),
  API_PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  MAX_UPLOAD_BYTES: z.coerce.number().default(1024 * 1024 * 1024),
  SESSION_RETENTION_HOURS: z.coerce.number().default(24),
  STREAM_TOKEN_TTL_SECONDS: z.coerce.number().default(3600),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().default("Breakc0de!"),
  ADMIN_TOKEN_TTL_SECONDS: z.coerce.number().default(12 * 60 * 60),
  STORAGE_ROOT: z.string().default("../../storage"),
  MEDIA_JOB_POLL_MS: z.coerce.number().default(5000),
  STREAM_MAX_CHUNK_BYTES: z.coerce.number().default(1 * 1024 * 1024),
  SESSION_IDLE_DESTROY_MS: z.coerce.number().default(5 * 60 * 1000),
  SESSION_IDLE_SWEEP_MS: z.coerce.number().default(60 * 1000),
  FFMPEG_PATH: z.string().default(ffmpegPath ?? "ffmpeg"),
  FFPROBE_PATH: z.string().default(ffprobeStatic.path ?? "ffprobe"),
  ENABLE_MEDIA_JOBS: z
    .string()
    .default("false")
    .transform((value) => value === "true")
});

const parsed = envSchema.parse(process.env);
const storageRoot = resolve(apiRoot, parsed.STORAGE_ROOT);
const legacyStorageRoot = resolve(process.cwd(), parsed.STORAGE_ROOT);
const workspaceRelativeStorageRoot = resolve(workspaceRoot, parsed.STORAGE_ROOT);
const storageRoots = Array.from(new Set([storageRoot, legacyStorageRoot, workspaceRelativeStorageRoot]));

export const env = {
  ...parsed,
  apiRoot,
  workspaceRoot,
  storageRoot,
  storageRoots,
  pgliteDataDir: parsed.PGLITE_DATA_DIR.startsWith("memory://")
    ? parsed.PGLITE_DATA_DIR
    : resolve(apiRoot, parsed.PGLITE_DATA_DIR)
};
