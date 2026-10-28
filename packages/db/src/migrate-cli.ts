#!/usr/bin/env node
/**
 * `pnpm --filter @gitinside/db migrate`: applies pending migrations to
 * `DATABASE_URL_UNPOOLED` (migrations need a direct connection, ADR-0055),
 * falling back to `DATABASE_URL` for local Docker Postgres.
 */
import { pathToFileURL } from "node:url";
import { runMigrations } from "./index.js";

/** What {@link main} needs from the outside world, injectable for tests. */
export interface MigrateIo {
  env: Readonly<Record<string, string | undefined>>;
  migrate: (url: string) => Promise<void>;
  log: (line: string) => void;
}

/** Picks the connection string, runs the migrations, and returns the exit code. */
export async function main(io: MigrateIo): Promise<number> {
  const url = io.env.DATABASE_URL_UNPOOLED || io.env.DATABASE_URL;
  if (!url) {
    io.log("Set DATABASE_URL_UNPOOLED (or DATABASE_URL for local development).");
    return 1;
  }
  try {
    await io.migrate(url);
  } catch (error) {
    // Never print the URL: it carries the password.
    io.log(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  io.log("Migrations applied.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({
    env: process.env,
    migrate: runMigrations,
    log: (line) => console.log(line),
  });
}
