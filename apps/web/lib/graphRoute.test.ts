// @vitest-environment node
import { analyses, completeAnalysis, repos, startAnalysis, upsertRepo } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { StorageError, type ObjectBody } from "@gitinside/worker/storage";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CDN_CACHEABLE_BYTES,
  GRAPH_CACHE_CONTROL,
  SPELLING_REDIRECT_CACHE_CONTROL,
  acceptsGzip,
  handleGraphRequest,
  type GraphRouteDeps,
} from "./graphRoute";
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

const params = (owner = "Acme", repo = "Shop", sha = SHA) => ({ owner, repo, sha });

describe("handleGraphRequest", () => {
  it("streams a published commit's graph gzipped, cacheable", async () => {
    await publish();
    const response = await handleGraphRequest(params("Acme", "Shop"), deps, "gzip, deflate, br");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(response.headers.get("cache-control")).toBe(GRAPH_CACHE_CONTROL);
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(GRAPH);
    expect(reads).toEqual([KEY]);
  });

  it("keeps a 13.4 MB graph (documenso's, M5.13) under the CDN's 10 MB cacheable size", async () => {
    await publish();
    // Like a real graph: repeated keys, varied IDs and paths.
    const nodes = Array.from({ length: 60_000 }, (_, i) => ({
      id: `file:@documenso/app:apps/web/src/components/part-${i}/index.tsx#Component${i}`,
      kind: "symbol",
      label: `Component${i}`,
      source: { path: `apps/web/src/components/part-${i}/index.tsx`, line: (i * 7) % 400 },
      confidence: "exact",
    }));
    const big = JSON.stringify({ version: 1, nodes, edges: [] });
    expect(big.length).toBeGreaterThan(13_400_000);
    objects.set(KEY, big);
    const response = await handleGraphRequest(params(), deps, "gzip");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBeLessThan(CDN_CACHEABLE_BYTES);
    expect(gunzipSync(bytes).toString()).toBe(big);
  });

  it.each([
    [null, true],
    ["gzip", true],
    ["br;q=1.0, gzip;q=0.8, *;q=0.1", true],
    ["GZIP", true],
    ["x-gzip", true],
    ["*", true],
    ["br, *;q=0.5", true],
    ["identity", false],
    ["", false],
    ["br", false],
    ["gzip;q=0", false],
    ["gzip;q=0.000, *", false],
    ["*;q=0", false],
  ])("decides gzip for Accept-Encoding %j: %s", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it("serves plain JSON to a client that refuses gzip, still varying on the header", async () => {
    await publish();
    const response = await handleGraphRequest(params(), deps, "identity");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(await response.text()).toBe(GRAPH);
  });

  it("gzips when the request names no encodings (RFC 9110: any is acceptable)", async () => {
    await publish();
    const response = await handleGraphRequest(params(), deps);
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("logs a graph whose served body is over the cacheable size, by size only", async () => {
    await publish();
    objects.set(KEY, "x".repeat(CDN_CACHEABLE_BYTES + 1));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await (await handleGraphRequest(params(), deps, "identity")).arrayBuffer();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "graph_uncacheable",
        bytes: CDN_CACHEABLE_BYTES + 1,
        encoding: "identity",
      }),
    );
    log.mockClear();
    // Gzipped, the same graph is a few KB: nothing to log.
    await (await handleGraphRequest(params(), deps, "gzip")).arrayBuffer();
    expect(log).not.toHaveBeenCalled();
  });

  it("redirects other spellings of the repo to the stored one before reading the bucket", async () => {
    await publish();
    for (const [owner, repo] of [
      ["acme", "shop"],
      ["ACME", "Shop"],
      ["Acme", "SHOP"],
    ]) {
      const response = await handleGraphRequest(params(owner, repo), deps);
      expect(response.status, `${owner}/${repo}`).toBe(308);
      expect(response.headers.get("location")).toBe(`/api/graph/Acme/Shop/${SHA}`);
      expect(response.headers.get("cache-control")).toBe(SPELLING_REDIRECT_CACHE_CONTROL);
    }
    expect(reads).toEqual([]);
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
