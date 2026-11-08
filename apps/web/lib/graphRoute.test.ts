// @vitest-environment node
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  analyses,
  completeAnalysis,
  createSession,
  findSession,
  repos,
  sessions,
  startAnalysis,
  upsertRepo,
  upsertUser,
  users,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { StorageError, type ObjectBody } from "@gitinside/worker/storage";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "./authRoute";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { CACHE_TAG_HEADER } from "./cdnCache";
import {
  CDN_CACHEABLE_BYTES,
  GRAPH_CACHE_CONTROL,
  PRIVATE_CACHE_CONTROL,
  SPELLING_REDIRECT_CACHE_CONTROL,
  acceptsGzip,
  handleGraphRequest,
  type GraphRouteDeps,
} from "./graphRoute";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";

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
  await t.db.delete(accessCache);
  await t.db.delete(sessions);
  await t.db.delete(users);
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

async function publish(visibility: "public" | "private" = "public", snapshotKey = KEY) {
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 1,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.1.0" });
  await completeAnalysis(t.db, id, {
    snapshotKey,
    stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
  });
  return repoId;
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
    expect(response.headers.get(CACHE_TAG_HEADER)).toBe("repo-1");
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
      expect(response.headers.get(CACHE_TAG_HEADER)).toBe("repo-1");
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

describe("handleGraphRequest for a private repo (M8.4b)", () => {
  const NOW = Date.parse("2026-11-07T12:00:00.000Z");
  const OCTO: FakeAccount = { id: 3_000_000_007, login: "octo" };
  const HUBOT: FakeAccount = { id: 3_000_000_008, login: "hubot" };
  const KEYS = sessionKeys("s".repeat(43));
  const PRIVATE_KEY = `private/41/repo/${SHA}/0.1.0.json.gz`;
  const ACME: FakeInstallation = {
    id: 41,
    account: { login: "acme", type: "Organization" },
    selection: "selected",
    repos: [{ owner: "Acme", name: "Shop", private: true, id: 1 }],
  };

  let github: FakeOAuth;
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    github = fakeOAuth();
    github.install(OCTO, [ACME]);
    const auth: AuthDeps = {
      db: t.db,
      client: { ...FAKE_CLIENT, fetch: github.fetch },
      keys: KEYS,
      now: () => NOW,
    };
    deps = { ...deps, auth };
    objects.set(PRIVATE_KEY, GRAPH);
    await publish("private", PRIVATE_KEY);
  });

  /** A live session for `account`: its `Cookie` header and what's needed to end it. */
  async function signIn(account: FakeAccount) {
    const issued = github.issue(account);
    const token = newToken();
    const tokenHash = hashToken(token);
    const userId = await upsertUser(t.db, { githubUserId: account.id, login: account.login });
    await createSession(t.db, {
      userId,
      tokenHash,
      githubTokens: sealTokens(KEYS, tokenHash, {
        accessToken: issued.accessToken,
        accessExpiresAt: NOW + EXPIRES_IN * 1000,
        refreshToken: issued.refreshToken,
        refreshExpiresAt: NOW + 1e10,
      }),
      lifetimeSeconds: 3600,
    });
    return { cookie: `theme=dark; ${SESSION_COOKIE}=${token}`, tokenHash, issued };
  }

  const lookups = () => github.requests.filter((r) => r.url.includes("/repositories/")).length;

  /** Everything a client can see of a response. */
  async function seen(response: Response) {
    return { status: response.status, headers: [...response.headers], body: await response.text() };
  }

  /** What a repo nobody analyzed answers: every refusal must look exactly like it. */
  async function missing() {
    return seen(await handleGraphRequest(params("Acme", "Nothing"), deps, "gzip"));
  }

  it("serves the graph to a user GitHub shows the repo to, never cacheable", async () => {
    const { cookie } = await signIn(OCTO);
    const response = await handleGraphRequest(params(), deps, "gzip", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers.get("vary")).toBe("accept-encoding, cookie");
    // Never in the CDN, so nothing to purge.
    expect(response.headers.get(CACHE_TAG_HEADER)).toBeNull();
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(GRAPH);
    expect(reads).toEqual([PRIVATE_KEY]);
    expect(github.requests.at(-1)?.url).toBe("https://api.github.com/repositories/1");

    // Checked on every view, from the 60 s cache.
    const plain = await handleGraphRequest(params(), deps, "identity", cookie);
    expect(await plain.text()).toBe(GRAPH);
    expect(plain.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(lookups()).toBe(1);
  });

  it("answers signed out, without sign-in, or with a dead cookie exactly as a missing graph", async () => {
    const expected = await missing();
    expect(expected.status).toBe(404);
    const { cookie } = await signIn(OCTO);
    const cases: [string, GraphRouteDeps, string | null][] = [
      ["signed out", deps, null],
      ["sign-in not configured", { db: deps.db, store: deps.store }, cookie],
      ["no such session", deps, `${SESSION_COOKIE}=${newToken()}`],
    ];
    for (const [name, d, c] of cases) {
      expect(await seen(await handleGraphRequest(params(), d, "gzip", c)), name).toEqual(expected);
    }
    expect(reads).toEqual([]);
    expect(lookups()).toBe(0);
  });

  it("refuses another signed-in user exactly as a missing graph, reading nothing", async () => {
    const octo = await signIn(OCTO);
    const hubot = await signIn(HUBOT); // signed in, but not in Acme's installation
    const expected = await missing();

    expect(await seen(await handleGraphRequest(params(), deps, "gzip", hubot.cookie))).toEqual(
      expected,
    );
    expect(reads).toEqual([]);
    expect((await handleGraphRequest(params(), deps, "gzip", octo.cookie)).status).toBe(200);
    expect(reads).toEqual([PRIVATE_KEY]);
    // The refusal is remembered for hubot alone.
    expect((await handleGraphRequest(params(), deps, "gzip", hubot.cookie)).status).toBe(404);
    expect(lookups()).toBe(2);
  });

  it("refuses access removed on GitHub once the check is 60 s old", async () => {
    const { cookie } = await signIn(OCTO);
    expect((await handleGraphRequest(params(), deps, "gzip", cookie)).status).toBe(200);
    github.install(OCTO, []);
    const [row] = await t.db.select().from(accessCache);
    await t.db.update(accessCache).set({
      checkedAt: new Date((row?.checkedAt.getTime() ?? 0) - ACCESS_TTL_SECONDS * 1000),
    });

    expect(await seen(await handleGraphRequest(params(), deps, "gzip", cookie))).toEqual(
      await missing(),
    );
    expect(reads).toEqual([PRIVATE_KEY]);
  });

  it("ends the session when GitHub refuses the user's token, answering as missing", async () => {
    const { cookie, tokenHash, issued } = await signIn(OCTO);
    github.revoke(issued.accessToken);
    expect(await seen(await handleGraphRequest(params(), deps, "gzip", cookie))).toEqual(
      await missing(),
    );
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("redirects another spelling only after the check, and never cacheably", async () => {
    const octo = await signIn(OCTO);
    const hubot = await signIn(HUBOT);
    const other = params("acme", "shop");

    const refused = await handleGraphRequest(other, deps, "gzip", hubot.cookie);
    expect(await seen(refused)).toEqual(await missing());
    const response = await handleGraphRequest(other, deps, "gzip", octo.cookie);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/graph/Acme/Shop/${SHA}`);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers.get("vary")).toBe("cookie");
    expect(response.headers.get(CACHE_TAG_HEADER)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("is unavailable, reading nothing, when the check can't decide; the next view asks again", async () => {
    const { cookie } = await signIn(OCTO);
    github.failNext(new Response("oops", { status: 502 }));
    const response = await handleGraphRequest(params(), deps, "gzip", cookie);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    expect(reads).toEqual([]);

    expect((await handleGraphRequest(params(), deps, "gzip", cookie)).status).toBe(200);
  });

  it("keeps a commit analyzed privately behind the check once the repo is public (M8.4d2)", async () => {
    // GitHub's facts made the row public; the commit's only analysis is under `private/`.
    await upsertRepo(t.db, {
      providerRepoId: 1,
      owner: "Acme",
      name: "Shop",
      visibility: "public",
      defaultBranch: "main",
    });
    expect(await seen(await handleGraphRequest(params(), deps, "gzip", null))).toEqual(
      await missing(),
    );
    const redirect = await handleGraphRequest(params("acme", "shop"), deps, "gzip", null);
    expect(redirect.status).toBe(404);
    expect(reads).toEqual([]);

    const { cookie } = await signIn(OCTO);
    const response = await handleGraphRequest(params(), deps, "gzip", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers.get("vary")).toBe("accept-encoding, cookie");
    expect(response.headers.get(CACHE_TAG_HEADER)).toBeNull();
    expect(reads).toEqual([PRIVATE_KEY]);
    expect(lookups()).toBe(1);
  });

  it("serves a public repo's public analysis to anyone, before a newer private one of the commit", async () => {
    const repoId = await publish("public", KEY);
    // The private one (0.1.0) finished first; re-analyzed publicly by another version later,
    // then by a newer private one again.
    const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.0.9" });
    await completeAnalysis(t.db, id, {
      snapshotKey: KEY,
      stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
    });
    const newer = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.2.0" });
    await completeAnalysis(t.db, newer.id, {
      snapshotKey: `private/41/repo/${SHA}/0.2.0.json.gz`,
      stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
    });
    objects.set(KEY, GRAPH);
    const { cookie } = await signIn(HUBOT);
    for (const c of [null, cookie]) {
      const response = await handleGraphRequest(params(), deps, "gzip", c);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(GRAPH_CACHE_CONTROL);
      expect(response.headers.get("vary")).toBe("accept-encoding");
    }
    expect(reads).toEqual([KEY, KEY]);
    expect(lookups()).toBe(0);
  });
});
