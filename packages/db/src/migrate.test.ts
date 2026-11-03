import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_LOCK_KEY, migrationsFolder, runMigrations } from "./index.js";

const serverUrl = process.env.TEST_DATABASE_URL;
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as {
  entries: unknown[];
};

/** Fresh empty databases on the test server, dropped after each test. */
const created: string[] = [];
async function emptyDatabase(): Promise<string> {
  const name = `gi_migrate_${randomBytes(6).toString("hex")}`;
  const admin = postgres(serverUrl!, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  return url.href;
}

afterEach(async () => {
  if (serverUrl === undefined || created.length === 0) return;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  try {
    for (const name of created.splice(0)) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

/** The SQLSTATE code on an error or any error it wraps. */
function codeOf(error: unknown): string | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ("code" in e && typeof e.code === "string") return e.code;
  }
  return undefined;
}

describe("runMigrations", () => {
  it("refuses a lock timeout that isn't a positive integer, before connecting", async () => {
    for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN]) {
      await expect(runMigrations("postgres://127.0.0.1:1/none", { lockTimeoutMs })).rejects.toThrow(
        RangeError,
      );
    }
  });

  // Real Postgres only (CI): PGlite has one connection, so two runs can't overlap.
  describe.skipIf(serverUrl === undefined)("on a real server", () => {
    it("applies each migration once when two runs start at once on an empty database", async () => {
      // Two worker instances starting together on a database that has never been migrated.
      const url = await emptyDatabase();
      await Promise.all([runMigrations(url), runMigrations(url)]);
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      try {
        const applied = await sql`select hash from drizzle.__drizzle_migrations`;
        expect(applied).toHaveLength(journal.entries.length);
        const [tables] =
          await sql`select count(*)::int as n from pg_tables where tablename = 'analyses'`;
        expect(tables?.n).toBe(1);
      } finally {
        await sql.end({ timeout: 5 });
      }
      // And a later start finds nothing pending.
      await runMigrations(url);
    }, 60_000);

    it("waits for another session's migration lock, then fails with 55P03 after the timeout", async () => {
      const url = await emptyDatabase();
      const holder = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await holder`select pg_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
        const started = performance.now();
        const error: unknown = await runMigrations(url, { lockTimeoutMs: 300 }).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(codeOf(error)).toBe("55P03");
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);
        // Nothing was applied while it waited.
        const [schema] =
          await holder`select count(*)::int as n from pg_namespace where nspname = 'drizzle'`;
        expect(schema?.n).toBe(0);

        // Once the holder lets go, the next run goes through.
        await holder`select pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`;
        await runMigrations(url, { lockTimeoutMs: 300 });
      } finally {
        await holder.end({ timeout: 5 });
      }
    }, 60_000);
  });
});
