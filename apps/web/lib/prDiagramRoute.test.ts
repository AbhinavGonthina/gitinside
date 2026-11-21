// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  pullRequests,
  recordPullRequestDiff,
  recordPullRequestHead,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { diffGraphs } from "@gitinside/diff";
import {
  parseGraph,
  stringifyDiff,
  stringifyGraph,
  type ArchitectureGraph,
} from "@gitinside/schema";
import { renderDiffDiagram } from "@gitinside/viewer/image";
import {
  derivedSecret,
  PR_DIAGRAM_PURPOSE,
  PR_DIAGRAM_TOKEN_SECONDS,
  signPrDiagram,
} from "@gitinside/worker/hmac";
import { StorageError, type ObjectBody } from "@gitinside/worker/storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import brokenBase from "../../../fixtures/diff-broken-base/expected.json";
import brokenHead from "../../../fixtures/diff-broken-head/expected.json";
import { prDiagramSearch } from "./canonical";
import { CACHE_TAG_HEADER } from "./cdnCache";
import { IMAGE_CSP } from "./csp";
import {
  handlePrDiagramRequest,
  PR_DIAGRAM_CACHE_CONTROL,
  PR_DIAGRAM_PRIVATE_CACHE_CONTROL,
  type PrDiagramDeps,
} from "./prDiagramRoute";

const EVENT_BASE = "a".repeat(40);
const MERGE_BASE = "e".repeat(40);
const HEAD = "c".repeat(40);
const VERSION = "0.1.0";
const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const KEY = derivedSecret("h".repeat(43), PR_DIAGRAM_PURPOSE);

const withSha = (graph: unknown, sha: string): ArchitectureGraph => {
  const parsed = parseGraph(graph);
  return { ...parsed, repo: { owner: "Acme", name: "Shop", sha } };
};
const BASE_GRAPH = withSha(brokenBase, MERGE_BASE);
const HEAD_GRAPH = withSha(brokenHead, HEAD);
const DIFF = diffGraphs(BASE_GRAPH, HEAD_GRAPH);

let t: TestDb;
/** The bucket's objects, by key. */
let objects: Map<string, string>;
/** Bucket reads, by key. */
let reads: string[];
/** `/api/graph` answers, by path, and the paths asked for. */
let cdn: Map<string, { status: number; text: string }>;
let cdnReads: string[];
let failure: Error | undefined;
let deps: PrDiagramDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(pullRequests);
  await t.db.delete(analyses);
  await t.db.delete(repos);
  objects = new Map();
  reads = [];
  cdn = new Map();
  cdnReads = [];
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
    async graph(path) {
      cdnReads.push(path);
      // A new Response each time: a clone's `cancel()` would wait for the original's.
      const { status, text } = cdn.get(path) ?? { status: 404, text: "{}" };
      return new Response(text, { status });
    },
    tokenKeys: [KEY],
    now: () => NOW,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

const diffKey = (repoId: string, version = VERSION) =>
  `private/41/${repoId}/diffs/${MERGE_BASE}-${HEAD}/${version}.json.gz`;
const publicKey = (sha: string) => `public/acme/shop/${sha}/${VERSION}.json.gz`;
const privateKey = (sha: string) => `private/41/repo/${sha}/${VERSION}.json.gz`;
const graphUrl = (sha: string) => `/api/graph/Acme/Shop/${sha}?v=${VERSION}`;

interface Setup {
  visibility?: "public" | "private";
  /** Snapshot keys of the merge base and head; public keys by default. */
  baseKey?: string;
  headKey?: string;
  /** The diff's analyzer version; the analyses' by default. */
  diffVersion?: string;
}

/** Acme/Shop (GitHub ID 1) with both commits analyzed and pull request 7's diff stored. */
async function setup(options: Setup = {}): Promise<{ repoId: string; key: string }> {
  const { visibility = "public", diffVersion = VERSION } = options;
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 1,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  for (const [sha, snapshotKey, graph] of [
    [MERGE_BASE, options.baseKey ?? publicKey(MERGE_BASE), BASE_GRAPH],
    [HEAD, options.headKey ?? publicKey(HEAD), HEAD_GRAPH],
  ] as const) {
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
    await completeAnalysis(t.db, id, {
      snapshotKey,
      stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
    });
    objects.set(snapshotKey, stringifyGraph(graph));
    cdn.set(graphUrl(sha), { status: 200, text: stringifyGraph(graph) });
  }
  const key = diffKey(repoId, diffVersion);
  await recordPullRequestHead(t.db, {
    repoId,
    number: 7,
    baseSha: EVENT_BASE,
    headSha: HEAD,
    headAt: new Date("2026-11-21T10:00:00Z"),
  });
  await recordPullRequestDiff(t.db, {
    repoId,
    number: 7,
    baseSha: EVENT_BASE,
    headSha: HEAD,
    diffKey: key,
    brokenCount: 1,
  });
  objects.set(key, stringifyDiff(DIFF));
  return { repoId, key };
}

const params = (owner = "Acme", repo = "Shop", base = MERGE_BASE, head = `${HEAD}.svg`) => ({
  owner,
  repo,
  base,
  head,
});
const token = (claims = {}, nowMs = NOW) =>
  signPrDiagram(KEY, { providerRepoId: 1, baseSha: MERGE_BASE, headSha: HEAD, ...claims }, nowMs);

/** Everything a client can see of a response. */
async function seen(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

describe("handlePrDiagramRequest: public repos", () => {
  it("draws the stored diff, cached a year, reading only the diff from the bucket", async () => {
    const { key } = await setup();
    const response = await handlePrDiagramRequest(params(), {}, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(PR_DIAGRAM_CACHE_CONTROL);
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_CSP);
    // Purged with the repo's other public answers when it turns private (ADR-0238).
    expect(response.headers.get(CACHE_TAG_HEADER)).toBe("repo-1");
    expect(await response.text()).toBe(renderDiffDiagram(DIFF, BASE_GRAPH, HEAD_GRAPH));
    expect(reads).toEqual([key]);
    expect(cdnReads.sort()).toEqual([graphUrl(MERGE_BASE), graphUrl(HEAD)].sort());

    const light = await handlePrDiagramRequest(params(), { theme: "light" }, deps);
    expect(await light.text()).toBe(
      renderDiffDiagram(DIFF, BASE_GRAPH, HEAD_GRAPH, { theme: "light" }),
    );
  });

  it("sends another spelling, or a token it doesn't need, to the stored URL before any read", async () => {
    await setup();
    for (const [p, options, location] of [
      [params("acme", "SHOP"), {}, `/api/pr-diagram/Acme/Shop/${MERGE_BASE}/${HEAD}.svg`],
      [
        params(),
        { theme: "dark", token: token() },
        `/api/pr-diagram/Acme/Shop/${MERGE_BASE}/${HEAD}.svg?theme=dark`,
      ],
    ] as const) {
      const response = await handlePrDiagramRequest(p, options, deps);
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(location);
      expect(response.headers.get(CACHE_TAG_HEADER)).toBe("repo-1");
    }
    expect(reads).toEqual([]);
    expect(cdnReads).toEqual([]);
  });

  it("is the one 404, reading nothing, for bad paths and commits without a stored diff", async () => {
    await setup();
    const expected = await seen(await handlePrDiagramRequest(params("Acme", "Nothing"), {}, deps));
    expect(expected.status).toBe(404);
    expect(new Headers(expected.headers).get("cache-control")).toBe("no-store");
    for (const p of [
      params("-bad"),
      params("Acme", "Shop", MERGE_BASE, HEAD),
      params("Acme", "Shop", "main"),
      params("Acme", "Shop", MERGE_BASE, `${HEAD.toUpperCase()}.svg`),
      // The record's own base isn't the diff's: the comment names the merge base.
      params("Acme", "Shop", EVENT_BASE),
      params("Acme", "Shop", MERGE_BASE, `${MERGE_BASE}.svg`),
      params("Acme", "Shop", HEAD, `${MERGE_BASE}.svg`),
    ]) {
      expect(await seen(await handlePrDiagramRequest(p, {}, deps)), JSON.stringify(p)).toEqual(
        expected,
      );
    }
    expect(reads).toEqual([]);
  });

  it("draws only a diff by the head graph's analyzer version, still named by a record", async () => {
    await setup({ diffVersion: "0.0.9" });
    expect((await handlePrDiagramRequest(params(), {}, deps)).status).toBe(404);
    await t.db.delete(pullRequests);
    await t.db.delete(analyses);
    await t.db.delete(repos);
    const { repoId } = await setup();
    // The pull request moved on: its record no longer names the diff.
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: EVENT_BASE,
      headSha: "f".repeat(40),
      headAt: new Date("2026-11-21T10:05:00Z"),
    });
    expect((await handlePrDiagramRequest(params(), {}, deps)).status).toBe(404);
    expect(reads).toEqual([]);
  });
});

describe("handlePrDiagramRequest: private repos", () => {
  const privately = {
    visibility: "private",
    baseKey: privateKey(MERGE_BASE),
    headKey: privateKey(HEAD),
  } as const;

  it("draws a private repo's diff only with a valid token, never cached, from the bucket", async () => {
    const { key } = await setup(privately);
    const response = await handlePrDiagramRequest(params(), { token: token() }, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PR_DIAGRAM_PRIVATE_CACHE_CONTROL);
    expect(response.headers.get(CACHE_TAG_HEADER)).toBeNull();
    expect(await response.text()).toBe(renderDiffDiagram(DIFF, BASE_GRAPH, HEAD_GRAPH));
    expect(reads).toEqual([key, privateKey(MERGE_BASE), privateKey(HEAD)]);
    // `/api/graph` would ask for a session GitHub's image proxy doesn't have.
    expect(cdnReads).toEqual([]);
    // Another spelling is drawn as it is: nothing private is cached to share.
    expect(
      (await handlePrDiagramRequest(params("acme", "shop"), { token: token() }, deps)).status,
    ).toBe(200);
  });

  it("answers any other token exactly as no diff, reading nothing", async () => {
    await setup(privately);
    const expected = await seen(await handlePrDiagramRequest(params("Acme", "Nothing"), {}, deps));
    const expired = token({}, NOW - PR_DIAGRAM_TOKEN_SECONDS * 1000);
    const cases: [string, string | null | undefined, PrDiagramDeps][] = [
      ["none", undefined, deps],
      ["null", null, deps],
      ["garbage", "x", deps],
      ["expired", expired, deps],
      ["another repo", token({ providerRepoId: 2 }), deps],
      ["another head", token({ headSha: "f".repeat(40) }), deps],
      ["base and head swapped", token({ baseSha: HEAD, headSha: MERGE_BASE }), deps],
      [
        "another key",
        signPrDiagram(
          derivedSecret("o".repeat(43), PR_DIAGRAM_PURPOSE),
          { providerRepoId: 1, baseSha: MERGE_BASE, headSha: HEAD },
          NOW,
        ),
        deps,
      ],
      ["no keys configured", token(), { ...deps, tokenKeys: [] }],
    ];
    for (const [name, given, d] of cases) {
      expect(await seen(await handlePrDiagramRequest(params(), { token: given }, d)), name).toEqual(
        expected,
      );
    }
    expect(reads).toEqual([]);
  });

  it("needs the token when only one side was analyzed privately, whatever the repo's visibility", async () => {
    for (const [side, options] of [
      ["merge base", { baseKey: privateKey(MERGE_BASE) }],
      ["head", { headKey: privateKey(HEAD) }],
    ] as const) {
      await t.db.delete(pullRequests);
      await t.db.delete(analyses);
      await t.db.delete(repos);
      reads = [];
      cdnReads = [];
      await setup(options);
      expect((await handlePrDiagramRequest(params(), {}, deps)).status, side).toBe(404);
      expect(reads, side).toEqual([]);
      const response = await handlePrDiagramRequest(params(), { token: token() }, deps);
      expect(response.status, side).toBe(200);
      expect(response.headers.get("cache-control"), side).toBe(PR_DIAGRAM_PRIVATE_CACHE_CONTROL);
      expect(cdnReads, side).toEqual([]);
    }
  });
});

describe("handlePrDiagramRequest: failures", () => {
  it("is a 404 when the diff object is gone, logging only an event name", async () => {
    await setup();
    objects.clear();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await handlePrDiagramRequest(params(), {}, deps)).status).toBe(404);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "pr_diagram_diff_missing" }));
  });

  it("is unavailable, never cached, when a graph doesn't come", async () => {
    await setup();
    cdn.set(graphUrl(HEAD), { status: 503, text: "{}" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handlePrDiagramRequest(params(), {}, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "pr_diagram_graph_unavailable", status: 503 }),
    );
    // A private repo's graph gone from the bucket.
    await t.db.delete(pullRequests);
    await t.db.delete(analyses);
    await t.db.delete(repos);
    await setup({
      visibility: "private",
      baseKey: privateKey(MERGE_BASE),
      headKey: privateKey(HEAD),
    });
    objects.delete(privateKey(HEAD));
    expect((await handlePrDiagramRequest(params(), { token: token() }, deps)).status).toBe(503);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "pr_diagram_graph_missing" }));
  });

  it("is unavailable when storage fails, and a 500 on anything else, logged by name", async () => {
    await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failure = new StorageError("GET answered 403 AccessDenied", 403, "AccessDenied");
    const unavailable = await handlePrDiagramRequest(params(), {}, deps);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "pr_diagram_read_failed",
        error: "StorageError",
        status: 403,
        s3Code: "AccessDenied",
      }),
    );
    failure = new TypeError("postgres://user:secret@db/x refused");
    const broken = await handlePrDiagramRequest(params(), {}, deps);
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain("secret");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "pr_diagram_failed", error: "TypeError" }),
    );
  });

  it("is unavailable until the database and bucket are configured", async () => {
    expect((await handlePrDiagramRequest(params(), {}, undefined)).status).toBe(503);
    expect((await handlePrDiagramRequest(params("-x"), {}, undefined)).status).toBe(404);
  });
});

describe("prDiagramSearch", () => {
  const url = (search: string) => `https://gitinside.test/api/pr-diagram/a/b/c/d.svg${search}`;

  it("keeps a known theme, then a well-formed token, and drops everything else", () => {
    const good = token();
    expect(prDiagramSearch(url(""))).toBe("");
    expect(prDiagramSearch(url("?theme=light"))).toBe("?theme=light");
    expect(prDiagramSearch(url("?theme=auto&n=1"))).toBe("");
    expect(prDiagramSearch(url(`?token=${good}`))).toBe(`?token=${good}`);
    expect(prDiagramSearch(url(`?token=${good}&theme=dark&n=2`))).toBe(`?theme=dark&token=${good}`);
    for (const bad of ["x", `${good}0`, good.toUpperCase(), `0${good}`]) {
      expect(prDiagramSearch(url(`?theme=dark&token=${bad}`)), bad).toBe("?theme=dark");
    }
  });
});
