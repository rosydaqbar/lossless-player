import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeDatabase, executeStatement } from "./client.js";

export async function runMigrations({ closeAfter = false }: { closeAfter?: boolean } = {}) {
  const migrationPath = resolve(process.cwd(), "migrations/0000_initial.sql");
  const migration = await readFile(migrationPath, "utf8");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await executeStatement(statement);
  }

  if (closeAfter) {
    await closeDatabase();
  }
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  runMigrations({ closeAfter: true }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
