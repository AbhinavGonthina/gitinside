import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffGraphs } from "@gitinside/diff";
import type { BrokenEdge } from "@gitinside/schema";
import { afterEach, describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of a fixture in a fresh temp folder. */
async function copyOf(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitinside-broken-"));
  dirs.push(dir);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** Replace `text` in a file of `dir`, failing when it isn't there. */
async function edit(dir: string, file: string, text: string, by: string): Promise<void> {
  const path = join(dir, file);
  const before = await readFile(path, "utf8");
  if (!before.includes(text)) throw new Error(`${file} has no ${JSON.stringify(text)}`);
  await writeFile(path, before.replace(text, by));
}

/**
 * The broken connections when head is `name` changed by `change`, both sides analyzed from
 * disk, so each request goes through the matcher's own path forms (ADR-0202, -0204, -0206).
 */
async function brokenAfter(
  name: string,
  change: (dir: string) => Promise<void>,
): Promise<BrokenEdge[]> {
  const repo = { owner: "fixtures", name };
  const base = await analyze(join(FIXTURES, name), repo);
  const dir = await copyOf(name);
  await change(dir);
  const head = await analyze(dir, repo);
  return diffGraphs(base, head).broken;
}

const summary = (broken: BrokenEdge[]) =>
  broken.map(({ from, to, reason }) => ({ from, to, reason }));

// M6 review C2: the diff re-resolved only `{env:…}` and loopback origins, so a removed route
// reached through any other path form of the matcher was never flagged.
describe("broken connections through the matcher's path forms (M6.11c)", () => {
  it("flags a route reached through an example env file's path (ADR-0202)", async () => {
    const broken = await brokenAfter("env-example-prefix", (dir) =>
      edit(dir, "server/src/index.js", 'auth.post("/login"', 'auth.post("/sign-in"'),
    );
    expect(summary(broken)).toEqual([
      {
        from: "symbol:client/src/api.js#signIn",
        to: "route:server/POST /api/auth/login",
        reason: "TARGET_REMOVED",
      },
    ]);
    expect(broken[0]?.sites).toEqual([{ file: "client/src/api.js", line: 7, column: 21 }]);
  }, 60_000);

  it("flags a route reached through a dev proxy's rewrite (ADR-0204)", async () => {
    const broken = await brokenAfter("vite-proxy", (dir) =>
      edit(dir, "server/src/index.ts", 'app.get("/users", ', 'app.get("/people", '),
    );
    expect(summary(broken)).toEqual([
      {
        from: "symbol:client/src/api.ts#listUsers",
        to: "route:server/GET /users",
        reason: "TARGET_REMOVED",
      },
    ]);
  }, 60_000);

  it("flags a route reached under a Next app's basePath (ADR-0206)", async () => {
    const broken = await brokenAfter("next-rewrites", (dir) =>
      rm(join(dir, "web/app/api/items/route.ts")),
    );
    // `/shop/legacy/items` is rewritten to the same route, so it breaks too.
    expect(summary(broken)).toEqual([
      {
        from: "symbol:web/lib/api.ts#listItems",
        to: "route:web/GET /api/items",
        reason: "TARGET_REMOVED",
      },
      {
        from: "symbol:web/lib/api.ts#listLegacyItems",
        to: "route:web/GET /api/items",
        reason: "TARGET_REMOVED",
      },
    ]);
  }, 60_000);

  it("flags a route reached through a Next app's rewrites (ADR-0206)", async () => {
    const broken = await brokenAfter("next-rewrites", (dir) =>
      edit(dir, "api/src/server.ts", 'app.get("/orders", ', 'app.get("/purchases", '),
    );
    expect(summary(broken)).toEqual([
      {
        from: "symbol:web/lib/api.ts#listOrders",
        to: "route:api/GET /orders",
        reason: "TARGET_REMOVED",
      },
    ]);
  }, 60_000);
});

// M6 review S2: an inline Express handler's calls had no edge, so a change to a function it
// calls was never flagged.
describe("broken connections from inline Express handlers (M6.11d)", () => {
  it("flags a call from an inline handler when its callee needs a new argument", async () => {
    const broken = await brokenAfter("express-inline-calls", (dir) =>
      edit(
        dir,
        "src/articles/service.ts",
        "deleteArticle(slug: string)",
        "deleteArticle(slug: string, by: string)",
      ),
    );
    expect(summary(broken)).toEqual([
      {
        from: "route:express-inline-calls/DELETE /api/articles/:slug",
        to: "symbol:express-inline-calls/src/articles/service.ts#deleteArticle",
        reason: "PARAMETERS_ADDED",
      },
    ]);
  }, 60_000);
});
