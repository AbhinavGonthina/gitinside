/**
 * A freshly migrated, private database for one test file, for this package's tests and for
 * other packages' (`@gitinside/db/testing`; ADR-0063). Tests only: it needs PGlite, a dev
 * dependency.
 *
 * - With `TEST_DATABASE_URL` set (CI's Postgres service, or local Docker
 *   Postgres), creates a new database on that server, migrates it with
 *   {@link runMigrations}, and drops it on close.
 * - Otherwise runs PGlite (Postgres compiled to WebAssembly) in memory and
 *   applies the same SQL migrations, so `pnpm test` works without Docker.
 */
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { createDb, migrationsFolder, runMigrations, schema } from "./index.js";

/** Either driver's database, typed by the shared schema. */
export type TestDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A migrated database, which engine it runs on, and how to dispose of it. */
export interface TestDb {
  db: TestDatabase;
  engine: "postgres" | "pglite";
  /** Applies the migrations again (they must be a no-op the second time). */
  migrateAgain: () => Promise<void>;
  close: () => Promise<void>;
}

/** Creates a migrated database for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (serverUrl) return createServerDb(serverUrl);
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return {
    db,
    engine: "pglite",
    migrateAgain: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  };
}

async function createServerDb(serverUrl: string): Promise<TestDb> {
  const name = `gi_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.href);
  const { db, close } = createDb(url.href, { max: 2 });
  return {
    db,
    engine: "postgres",
    migrateAgain: () => runMigrations(url.href),
    close: async () => {
      await close();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

/**
 * Awaits a query that must fail and returns Postgres's SQLSTATE code
 * (`23505` unique, `23503` foreign key, `23514` check, `23502` not null).
 * Drizzle wraps driver errors, so the code may sit on `cause`.
 */
export async function pgErrorCode(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      if ("code" in e && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    throw error;
  }
  throw new Error("Expected the query to fail, but it succeeded.");
}
