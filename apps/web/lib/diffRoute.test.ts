// @vitest-environment node
import {
  accessCache,
  analyses,
  completeAnalysis,
  createSession,
  pullRequests,
  recordPullRequestDiff,
  recordPullRequestHead,
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
import { handleDiffRequest } from "./diffRoute";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { PRIVATE_CACHE_CONTROL, type GraphRouteDeps } from "./graphRoute";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";

const EVENT_BASE = "a".repeat(40);
const MERGE_BASE = "e".repeat(40);
const HEAD = "c".repeat(40);
const VERSION = "0.1.0";
const DIFF = '{"schemaVersion":1,"nodes":{}}';

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
  await t.db.delete(pullRequests);
  await t.db.delete(analyses);
  await t.db.delete(repos);
  objects = new Map();
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

const diffKey = (repoId: string, version = VERSION) =>
  `private/41/${repoId}/diffs/${MERGE_BASE}-${HEAD}/${version}.json.gz`;

interface Setup {
  visibility?: "public" | "private";
  /** Snapshot keys of the merge base and head; public keys by default. */
  baseKey?: string;
  headKey?: string;
  /** The diff's analyzer version; the analyses' by default. */
  diffVersion?: string;
  /** Leave out the merge base's analysis. */
  noBase?: boolean;
}

/** Acme/Shop with both commits analyzed and pull request 7's diff stored. */
async function setup(options: Setup = {}): Promise<{ repoId: string; key: string }> {
  const { visibility = "public", diffVersion = VERSION } = options;
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 1,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  const analyzed: [string, string | undefined][] = [
    [HEAD, options.headKey],
    ...(options.noBase ? [] : ([[MERGE_BASE, options.baseKey]] as [string, string | undefined][])),
  ];
  for (const [sha, snapshotKey] of analyzed) {
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
    await completeAnalysis(t.db, id, {
      snapshotKey: snapshotKey ?? `public/acme/shop/${sha}/${VERSION}.json.gz`,
      stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
    });
  }
  const key = diffKey(repoId, diffVersion);
  await recordPullRequestHead(t.db, {
    repoId,
    number: 7,
    baseSha: EVENT_BASE,
    headSha: HEAD,
    headAt: new Date("2026-11-08T10:00:00Z"),
  });
  await recordPullRequestDiff(t.db, {
    repoId,
    number: 7,
    baseSha: EVENT_BASE,
    headSha: HEAD,
    diffKey: key,
    brokenCount: 0,
  });
  objects.set(key, DIFF);
  return { repoId, key };
}

const params = (owner = "Acme", repo = "Shop", base = MERGE_BASE, head = HEAD) => ({
  owner,
  repo,
  base,
  head,
});

/** Everything a client can see of a response. */
async function seen(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

describe("handleDiffRequest", () => {
  it("streams a public repo's stored diff to anyone, gzipped, never cacheable", async () => {
    const { key } = await setup();
    const response = await handleDiffRequest(params(), deps, "gzip, br");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(response.headers.get("vary")).toBe("accept-encoding, cookie");
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(DIFF);
    expect(reads).toEqual([key]);

    const plain = await handleDiffRequest(params("acme", "SHOP"), deps, "identity");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(DIFF);
  });

  it("is the one 404, reading nothing, for bad paths and commits without a stored diff", async () => {
    await setup();
    const expected = await seen(await handleDiffRequest(params("Acme", "Nothing"), deps));
    expect(expected.status).toBe(404);
    expect(JSON.parse(expected.body)).toMatchObject({ error: "DIFF_NOT_FOUND" });
    expect(new Headers(expected.headers).get("cache-control")).toBe("no-store");
    for (const p of [
      params("-bad"),
      params("Acme", "Shop", "main"),
      params("Acme", "Shop", MERGE_BASE, HEAD.toUpperCase()),
      // The record's own base isn't the link's: the comment links the merge base.
      params("Acme", "Shop", EVENT_BASE),
      params("Acme", "Shop", MERGE_BASE, MERGE_BASE),
      params("Acme", "Shop", HEAD, MERGE_BASE),
    ]) {
      expect(await seen(await handleDiffRequest(p, deps)), JSON.stringify(p)).toEqual(expected);
    }
    expect(reads).toEqual([]);
  });

  it("serves only a diff by the analyzer version of the head's graph", async () => {
    await setup({ diffVersion: "0.0.9" });
    expect((await handleDiffRequest(params(), deps)).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("serves nothing once the merge base has no stored analysis", async () => {
    await setup({ noBase: true });
    expect((await handleDiffRequest(params(), deps)).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("serves nothing once the pull request moves on", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: EVENT_BASE,
      headSha: "f".repeat(40),
      headAt: new Date("2026-11-08T10:05:00Z"),
    });
    expect((await handleDiffRequest(params(), deps)).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("is a 404 when the object is gone, logging only an event name", async () => {
    await setup();
    objects.clear();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await handleDiffRequest(params(), deps)).status).toBe(404);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "diff_object_missing" }));
  });

  it("is unavailable when storage fails, and a 500 on anything else, logged by name", async () => {
    await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failure = new StorageError("GET answered 403 AccessDenied", 403, "AccessDenied");
    const unavailable = await handleDiffRequest(params(), deps);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "UNAVAILABLE",
      message: UNAVAILABLE_MESSAGE,
    });
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "diff_read_failed",
        error: "StorageError",
        status: 403,
        s3Code: "AccessDenied",
      }),
    );
    failure = new TypeError("postgres://user:secret@db/x refused");
    const broken = await handleDiffRequest(params(), deps);
    expect(broken.status).toBe(500);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "diff_failed", error: "TypeError" }));
  });

  it("is unavailable until the database and bucket are configured", async () => {
    const response = await handleDiffRequest(params(), undefined);
    expect(response.status).toBe(503);
    expect((await handleDiffRequest(params("-x"), undefined)).status).toBe(404);
  });
});

describe("handleDiffRequest behind the access check", () => {
  const NOW = Date.parse("2026-11-08T12:00:00.000Z");
  const OCTO: FakeAccount = { id: 3_000_000_007, login: "octo" };
  const HUBOT: FakeAccount = { id: 3_000_000_008, login: "hubot" };
  const KEYS = sessionKeys("s".repeat(43));
  const ACME: FakeInstallation = {
    id: 41,
    account: { login: "acme", type: "Organization" },
    selection: "selected",
    repos: [{ owner: "Acme", name: "Shop", private: true, id: 1 }],
  };
  const privateKey = (sha: string) => `private/41/repo/${sha}/${VERSION}.json.gz`;

  let github: FakeOAuth;
  beforeEach(() => {
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
  });

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
    return `${SESSION_COOKIE}=${token}`;
  }

  const lookups = () => github.requests.filter((r) => r.url.includes("/repositories/")).length;
  const missing = async () =>
    seen(await handleDiffRequest(params("Acme", "Nothing"), deps, "gzip"));

  it("serves a private repo's diff to a user GitHub shows the repo to", async () => {
    const { key } = await setup({
      visibility: "private",
      baseKey: privateKey(MERGE_BASE),
      headKey: privateKey(HEAD),
    });
    const response = await handleDiffRequest(params(), deps, "identity", await signIn(OCTO));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(await response.text()).toBe(DIFF);
    expect(reads).toEqual([key]);
    expect(lookups()).toBe(1);
  });

  it("answers signed out, without sign-in, a dead cookie, or another user exactly as no diff", async () => {
    await setup({
      visibility: "private",
      baseKey: privateKey(MERGE_BASE),
      headKey: privateKey(HEAD),
    });
    const expected = await missing();
    expect(expected.status).toBe(404);
    const octo = await signIn(OCTO);
    const hubot = await signIn(HUBOT);
    const cases: [string, GraphRouteDeps, string | null][] = [
      ["signed out", deps, null],
      ["sign-in not configured", { db: deps.db, store: deps.store }, octo],
      ["no such session", deps, `${SESSION_COOKIE}=${newToken()}`],
      ["another user", deps, hubot],
    ];
    for (const [name, d, cookie] of cases) {
      expect(await seen(await handleDiffRequest(params(), d, "gzip", cookie)), name).toEqual(
        expected,
      );
    }
    expect(reads).toEqual([]);
  });

  it("checks access when only one side was analyzed privately, whatever the repo's visibility", async () => {
    for (const [side, options] of [
      ["merge base", { baseKey: privateKey(MERGE_BASE) }],
      ["head", { headKey: privateKey(HEAD) }],
    ] as const) {
      await t.db.delete(accessCache);
      await t.db.delete(pullRequests);
      await t.db.delete(analyses);
      await t.db.delete(repos);
      reads = [];
      const { key } = await setup(options);
      expect(await seen(await handleDiffRequest(params(), deps, "gzip", null)), side).toEqual(
        await missing(),
      );
      expect(reads, side).toEqual([]);
      const response = await handleDiffRequest(params(), deps, "identity", await signIn(OCTO));
      expect(response.status, side).toBe(200);
      expect(reads, side).toEqual([key]);
    }
  });

  it("is unavailable, reading nothing, when the check can't decide", async () => {
    await setup({
      visibility: "private",
      baseKey: privateKey(MERGE_BASE),
      headKey: privateKey(HEAD),
    });
    const cookie = await signIn(OCTO);
    github.failNext(new Response("oops", { status: 502 }));
    const response = await handleDiffRequest(params(), deps, "gzip", cookie);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    expect(reads).toEqual([]);
  });
});
