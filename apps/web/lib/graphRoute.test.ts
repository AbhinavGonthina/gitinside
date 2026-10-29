// @vitest-environment node
import { analyses, completeAnalysis, repos, startAnalysis, upsertRepo } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { StorageError, type ObjectBody } from "@gitinside/worker/storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GRAPH_CACHE_CONTROL, handleGraphRequest, type GraphRouteDeps } from "./graphRoute";
import { UNAVAILABLE_MESSAGE } from "./messages";

const SHA = "d".repeat(40);
const KEY = `public/acme/shop/${SHA}/0.1.0.json.gz`;
const GRAPH = '{"version":1,"nodes":[],"edges":[]}';

let t: TestDb;
let objects: Map<string, string>;
let reads: string[];
let failure: Error | undefined;
let deps: GraphRouteDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  objects = new Map([[KEY, GRAPH]]);
  reads = [];
  failure = undefined;
  deps = {
    db: t.db,
    store: {
      async get(key): Promise<ObjectBody | undefined> {
        reads.push(key);
        if (failure) throw failure;
        const text = objects.get(key);
        if (text === undefined) return undefined;
        return { body: new Response(text).body!, contentType: "application/json" };
      },
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function publish(visibility: "public" | "private" = "public") {
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 1,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.1.0" });
  await completeAnalysis(t.db, id, {
    snapshotKey: KEY,
    stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
  });
}

const params = (owner = "acme", repo = "shop", sha = SHA) => ({ owner, repo, sha });

describe("handleGraphRequest", () => {
  it("streams a published commit's graph, cacheable", async () => {
    await publish();
    const response = await handleGraphRequest(params("ACME", "Shop"), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(GRAPH_CACHE_CONTROL);
    expect(await response.text()).toBe(GRAPH);
    expect(reads).toEqual([KEY]);
  });

  it("is a 404, read from nowhere, for bad names, bad SHAs, and unknown commits", async () => {
    await publish();
    for (const p of [
      params("-bad"),
      params("acme", ".."),
      params("acme", "shop", SHA.toUpperCase()),
      params("acme", "shop", "abc"),
      params("acme", "shop", "e".repeat(40)),
      params("acme", "other"),
    ]) {
      const response = await handleGraphRequest(p, deps);
      expect(response.status, JSON.stringify(p)).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: "GRAPH_NOT_FOUND" });
    }
    expect(reads).toEqual([]);
  });

  it("never serves a private repo's graph", async () => {
    await publish("private");
    expect((await handleGraphRequest(params(), deps)).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("is a 404 when the object is gone, logging only an event name", async () => {
    await publish();
    objects.clear();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await handleGraphRequest(params(), deps)).status).toBe(404);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "graph_object_missing" }));
  });

  it("is unavailable when storage fails, logging status and code only", async () => {
    await publish();
    failure = new StorageError("GET answered 403 AccessDenied", 403, "AccessDenied");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleGraphRequest(params(), deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "graph_read_failed",
        error: "StorageError",
        status: 403,
        s3Code: "AccessDenied",
      }),
    );
  });

  it("is a 500 on anything else, logged by name", async () => {
    await publish();
    failure = new TypeError("postgres://user:secret@db/x refused");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleGraphRequest(params(), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "INTERNAL" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "graph_failed", error: "TypeError" }));
  });

  it("is unavailable until the database and bucket are configured", async () => {
    const response = await handleGraphRequest(params(), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // A bad path is still a 404 first.
    expect((await handleGraphRequest(params("-x"), undefined)).status).toBe(404);
  });
});
