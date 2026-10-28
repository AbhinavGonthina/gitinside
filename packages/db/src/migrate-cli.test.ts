import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "./index.js";
import { main, type MigrateIo } from "./migrate-cli.js";

function io(env: MigrateIo["env"], migrate: MigrateIo["migrate"] = async () => {}) {
  const lines: string[] = [];
  const urls: string[] = [];
  return {
    lines,
    urls,
    io: {
      env,
      migrate: async (url: string) => {
        urls.push(url);
        await migrate(url);
      },
      log: (line: string) => lines.push(line),
    } satisfies MigrateIo,
  };
}

describe("migrate CLI", () => {
  it("prefers the direct connection over the pooled one", async () => {
    const t = io({ DATABASE_URL: "postgres://pooled", DATABASE_URL_UNPOOLED: "postgres://direct" });
    expect(await main(t.io)).toBe(0);
    expect(t.urls).toEqual(["postgres://direct"]);
    expect(t.lines).toEqual(["Migrations applied."]);
  });

  it("falls back to DATABASE_URL for local development", async () => {
    const t = io({ DATABASE_URL: "postgres://local", DATABASE_URL_UNPOOLED: "" });
    expect(await main(t.io)).toBe(0);
    expect(t.urls).toEqual(["postgres://local"]);
  });

  it("fails with instructions when no URL is set", async () => {
    const t = io({});
    expect(await main(t.io)).toBe(1);
    expect(t.urls).toEqual([]);
    expect(t.lines[0]).toMatch(/DATABASE_URL_UNPOOLED/);
  });

  it("reports a failure without printing the connection string", async () => {
    const url = "postgres://user:s3cret@db.example/gitinside";
    const t = io({ DATABASE_URL_UNPOOLED: url }, async () => {
      throw new Error("connection refused");
    });
    expect(await main(t.io)).toBe(1);
    expect(t.lines).toEqual(["Migration failed: connection refused"]);
    expect(t.lines.join("\n")).not.toContain("s3cret");
  });

  it("ships the migrations next to the built code", () => {
    expect(existsSync(join(migrationsFolder, "0000_init.sql"))).toBe(true);
  });
});
