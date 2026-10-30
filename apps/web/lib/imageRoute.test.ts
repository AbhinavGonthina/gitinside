// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { parseGraph } from "@gitinside/schema";
import { badgeMessage, renderBadge, renderDiagram } from "@gitinside/viewer/image";
import { StorageError, type ObjectBody } from "@gitinside/worker/storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import shopDemo from "../../../fixtures/shop-demo/expected.json";
import { IMAGE_CSP } from "./csp";
import { fakeGitHub, type FakeGitHub, type FakeRepo } from "./github.testkit";
import { handleGraphRequest } from "./graphRoute";
import {
  FAILED_IMAGE_CACHE_CONTROL,
  GRAPH_READ_TIMEOUT_MS,
  IMAGE_CACHE_CONTROL,
  cdnGraphReader,
  LINK_ONLY_MESSAGE,
  handleImageRequest,
  imageTheme,
  type ImageRouteDeps,
} from "./imageRoute";
import { createHeadCache } from "./repoView";
import type { AnalyzeJob, WorkerClient } from "./worker";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const VERSION = "0.2.0";
const ID = 4242;
const key = (sha: string) => `public/acme/shop/${sha}/${VERSION}.json.gz`;
const GRAPH = parseGraph(shopDemo);
const LINK_ONLY = renderBadge({ message: LINK_ONLY_MESSAGE, tone: "muted" });

let t: TestDb;
let shop: FakeRepo;
let gh: FakeGitHub;
let objects: Map<string, string>;
let reads: string[];
let graphPaths: string[];
let enqueued: AnalyzeJob[];
let failure: Error | undefined;
let deps: ImageRouteDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(rateLimits);
  shop = { id: ID, owner: "Acme", name: "Shop", sha: OLD };
  gh = fakeGitHub([shop]);
  objects = new Map([[key(OLD), JSON.stringify(shopDemo)]]);
  reads = [];
  graphPaths = [];
  enqueued = [];
  failure = undefined;
  const worker: Pick<WorkerClient, "enqueue"> = {
    async enqueue(job) {
      enqueued.push(job);
      return { id: `analyze-${job.sha.slice(0, 8)}`, created: true };
    },
  };
  deps = {
    view: {
      db: t.db,
      worker,
      github: { fetch: gh.fetch },
      analyzerVersion: VERSION,
      heads: createHeadCache(),
    },
    // The real `/api/graph` handler over a fake bucket, as the CDN would reach it.
    async graph(path) {
      graphPaths.push(path);
      const [, owner, repo, sha] = /^\/api\/graph\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)!;
      const params = {
        owner: decodeURIComponent(owner!),
        repo: decodeURIComponent(repo!),
        sha: sha!,
      };
      return handleGraphRequest(params, {
        db: t.db,
        store: {
          async get(k): Promise<ObjectBody | undefined> {
            reads.push(k);
            if (failure) throw failure;
            const text = objects.get(k);
            if (text === undefined) return undefined;
            return { body: new Response(text).body!, contentType: "application/json" };
          },
        },
      });
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function publish(sha = OLD, visibility: "public" | "private" = "public") {
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: ID,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
  await completeAnalysis(t.db, id, {
    snapshotKey: key(sha),
    stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
  });
}

const badge = (repo = "shop.svg", owner = "acme") =>
  handleImageRequest("badge", { owner, repo }, {}, deps);
const diagram = (theme?: string) =>
  handleImageRequest("diagram", { owner: "acme", repo: "shop.svg" }, { theme }, deps);

function expectImage(response: Response, cacheControl: string): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe(cacheControl);
  expect(response.headers.get("content-security-policy")).toBe(IMAGE_CSP);
}

describe("handleImageRequest", () => {
  it("serves the badge of a repo's latest diagram, cached 10 minutes", async () => {
    await publish();
    const response = await badge("Shop.svg", "ACME");
    expectImage(response, IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(renderBadge({ message: badgeMessage(GRAPH) }));
    expect(badgeMessage(GRAPH)).toMatch(/^\d+ services? · /);
    // Through the day-cached graph URL in the stored spelling, never the bucket directly.
    expect(graphPaths).toEqual([`/api/graph/Acme/Shop/${OLD}`]);
    expect(reads).toEqual([key(OLD)]);
    expect(enqueued).toEqual([]);
  });

  it("serves the live image in the theme asked for, auto otherwise", async () => {
    await publish();
    for (const [asked, theme] of [
      ["dark", "dark"],
      ["light", "light"],
      [undefined, "auto"],
      ["<script>", "auto"],
    ] as const) {
      const response = await diagram(asked);
      expectImage(response, IMAGE_CACHE_CONTROL);
      expect(await response.text(), String(asked)).toBe(renderDiagram(GRAPH, { theme }));
    }
    expect(imageTheme(null)).toBe("auto");
    expect(imageTheme("auto")).toBe("auto");
  });

  it("checks on view: a new commit is enqueued, charged to the repo, while the last diagram shows", async () => {
    await publish();
    shop.sha = NEW;
    const response = await badge();
    expectImage(response, IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(renderBadge({ message: badgeMessage(GRAPH) }));
    expect(enqueued).toEqual([{ owner: "Acme", repo: "Shop", sha: NEW }]);
    const slots = await t.db.select().from(rateLimits);
    expect(slots.map((s) => [s.key, s.count])).toEqual([[`repo:${ID}`, 1]]);
  });

  it("shows the newer diagram once it's finished", async () => {
    await publish();
    await publish(NEW);
    shop.sha = NEW;
    const empty = {
      ...shopDemo,
      nodes: shopDemo.nodes.filter((n) => n.kind === "system"),
      edges: [],
    };
    objects.set(key(NEW), JSON.stringify(empty));
    const response = await badge();
    expect(await response.text()).toBe(renderBadge({ message: "no services found" }));
    expect(reads).toEqual([key(NEW)]);
  });

  it("is the same link-only badge for unknown, private, gone, and impossible repos", async () => {
    const answers: string[] = [];
    // Never analyzed: no GitHub call, nothing read.
    answers.push(await (await badge()).text());
    expect(gh.requests).toEqual([]);
    // Private: never in our public rows.
    await publish(OLD, "private");
    answers.push(await (await badge()).text());
    // Gone on GitHub since it was analyzed (or went private there).
    await t.db.delete(analyses);
    await t.db.delete(repos);
    await publish();
    shop.private = true;
    const gone = await badge();
    expectImage(gone, IMAGE_CACHE_CONTROL);
    answers.push(await gone.text());
    // Names GitHub wouldn't allow.
    answers.push(await (await badge("..svg")).text());
    answers.push(await (await badge("shop.svg", "-bad")).text());
    expect(answers).toEqual(Array(5).fill(LINK_ONLY));
    expect(reads).toEqual([]);
  });

  it("is a 404 for a path that isn't an image URL", async () => {
    await publish();
    for (const repo of ["shop", "shop.png", "shop.svg.json"]) {
      const response = await badge(repo);
      expect(response.status, repo).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("is the link-only badge for a minute when the server isn't configured", async () => {
    const response = await handleImageRequest(
      "badge",
      { owner: "a", repo: "b.svg" },
      {},
      undefined,
    );
    expectImage(response, FAILED_IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(LINK_ONLY);
  });

  it("is the link-only badge for a minute when storage fails, logging the graph's status", async () => {
    await publish();
    failure = new StorageError("GET answered 403 AccessDenied", 403, "AccessDenied");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await diagram();
    expectImage(response, FAILED_IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(LINK_ONLY);
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ event: "image_graph_unavailable", status: 503 }),
    );
  });

  it("is the link-only badge for a minute when the graph can't be fetched, logged by name", async () => {
    await publish();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timedOut: ImageRouteDeps = {
      ...deps,
      graph: () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    };
    const response = await handleImageRequest(
      "badge",
      { owner: "acme", repo: "shop.svg" },
      {},
      timedOut,
    );
    expectImage(response, FAILED_IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(LINK_ONLY);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "image_failed", error: "TimeoutError" }),
    );
  });

  it("is the link-only badge for a minute when the snapshot is gone or unreadable", async () => {
    await publish();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    objects.clear();
    expectImage(await badge(), FAILED_IMAGE_CACHE_CONTROL);
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ event: "image_graph_unavailable", status: 404 }),
    );

    objects.set(key(OLD), '{"nodes":"</svg><script>"}');
    const response = await badge();
    expectImage(response, FAILED_IMAGE_CACHE_CONTROL);
    expect(await response.text()).toBe(LINK_ONLY);
    const logged = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string });
    expect(logged.at(-1)?.event).toBe("image_failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("script");
  });

  it("is the link-only badge for a minute when the database fails, logged by name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: ImageRouteDeps = {
      ...deps,
      view: {
        ...deps.view,
        db: new Proxy(deps.view.db, {
          get() {
            throw new TypeError("postgres://user:secret@db/x refused");
          },
        }),
      },
    };
    const response = await handleImageRequest("badge", { owner: "a", repo: "b.svg" }, {}, broken);
    expectImage(response, FAILED_IMAGE_CACHE_CONTROL);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "image_failed", error: "TypeError" }));
  });
});

describe("cdnGraphReader", () => {
  it("asks the image's own origin for the graph, with a timeout", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const read = cdnGraphReader("https://gitinside.test", async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("{}");
    });
    await read(`/api/graph/Acme/Shop/${OLD}`);
    expect(calls.map((c) => c.url)).toEqual([`https://gitinside.test/api/graph/Acme/Shop/${OLD}`]);
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(GRAPH_READ_TIMEOUT_MS).toBe(10_000);
  });

  it("never leaves the origin", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const read = cdnGraphReader("https://gitinside.test", fetchSpy);
    await expect(read("//evil.example/api/graph/a/b/c")).rejects.toThrow(TypeError);
    await expect(read("https://evil.example/x")).rejects.toThrow(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
