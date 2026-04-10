import { mkdir } from "node:fs/promises";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { env } from "../config/env.js";

type PgSqlClient = ReturnType<typeof postgres>;
type PgliteClient = PGlite;

let sqlClient: PgSqlClient | null = null;
let pgliteClient: PgliteClient | null = null;

export let db: any;
export type AppDatabase = any;

async function initializePglite() {
  if (!env.pgliteDataDir.startsWith("memory://")) {
    await mkdir(env.pgliteDataDir, { recursive: true });
  }
  pgliteClient = new PGlite(env.pgliteDataDir);
  db = drizzlePglite({ client: pgliteClient });
}

async function initializePostgres() {
  sqlClient = postgres(env.DATABASE_URL, {
    prepare: false,
    max: 5
  });
  db = drizzlePg(sqlClient);
}

if (env.DATABASE_DRIVER === "pglite") {
  await initializePglite();
} else {
  await initializePostgres();
}

export async function executeStatement(statement: string) {
  if (env.DATABASE_DRIVER === "pglite") {
    await pgliteClient?.exec(statement);
    return;
  }

  await sqlClient?.unsafe(statement);
}

export async function closeDatabase() {
  if (env.DATABASE_DRIVER === "pglite") {
    await pgliteClient?.close();
    return;
  }

  await sqlClient?.end();
}
