// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  failAnalysis,
  rateLimits,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGitHub, type FakeGitHub, type FakeRepo } from "./github.testkit";
import {
  createHeadCache,
  graphPath,
  RECHECKS_PER_HOUR,
  viewRepo,
  type RepoViewDeps,
} from "./repoView";
import { WorkerUnavailableError, type AnalyzeJob, type WorkerClient } from "./worker";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const VERSION = "0.2.0";
const ID = 4242;

/** A worker that dedupes by commit like the real one, and can be switched off. */
function fakeWorker() {
  const jobs = new Set<string>();
  const calls: AnalyzeJob[] = [];
  let down = false;
  const client: Pick<WorkerClient, "enqueue"> = {
    async enqueue(job) {
      calls.push(job);
      if (down) throw new WorkerUnavailableError("status 503");
      const id = `analyze-${job.sha.slice(0, 32)}`;
      const created = !jobs.has(id);
      jobs.add(id);
      return { id, created };
    },
  };
  return { client, calls, jobs, setDown: (value: boolean) => void (down = value) };
}

let t: TestDb;
let shop: FakeRepo;
let gh: FakeGitHub;
let worker: ReturnType<typeof fakeWorker>;
let clock: number;
let deps: RepoViewDeps;

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
  worker = fakeWorker();
  clock = 1_000_000;
  deps = {
    db: t.db,
    worker: worker.client,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    heads: createHeadCache({ now: () => clock }),
  };
});

async function repoId(): Promise<string> {
  const facts = { providerRepoId: ID, owner: "Acme", name: "Shop", visibility: "public" as const };
  return (await upsertRepo(t.db, { ...facts, defaultBranch: "main" })).id;
}

/** A finished analysis of `sha`. Each call finishes later than the one before (`now()`). */
async function done(sha: string, version = VERSION) {
  const { id } = await startAnalysis(t.db, {
    repoId: await repoId(),
    sha,
    analyzerVersion: version,
  });
  await completeAnalysis(t.db, id, {
    snapshotKey: `public/acme/shop/${sha}/${version}.json.gz`,
    stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
  });
  return id;
}

async function rows() {
  return t.db
    .select({ sha: analyses.sha, status: analyses.status, version: analyses.analyzerVersion })
    .from(analyses)
    .orderBy(analyses.sha, analyses.analyzerVersion);
}

async function repoSlots(): Promise<number> {
  const all = await t.db.select().from(rateLimits);
  return all.find((r) => r.key === `repo:${ID}`)?.count ?? 0;
}

const ready = (sha: string, head: object, version = VERSION) => ({
  status: "ready",
  owner: "Acme",
  repo: "Shop",
  sha,
  analyzerVersion: version,
  graphUrl: `/api/graph/Acme/Shop/${sha}`,
  head,
});

describe("viewRepo", () => {
  it("offers to analyze a repo with no finished analysis, without asking GitHub", async () => {
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "acme",
      repo: "shop",
    });
    // A failed or running analysis isn't a diagram either.
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: OLD,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_FILES");
    expect((await viewRepo({ owner: "acme", repo: "shop" }, deps)).status).toBe("not-analyzed");
    expect(gh.requests).toEqual([]);
  });

  it("serves a permalink as is, never checking GitHub; an unknown commit is missing", async () => {
    await done(OLD);
    shop.sha = NEW;
    expect(await viewRepo({ owner: "ACME", repo: "shop", sha: OLD }, deps)).toEqual(
      ready(OLD, { state: "pinned" }),
    );
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: NEW }, deps)).toEqual({
      status: "missing",
    });
    expect(gh.requests).toEqual([]);
    expect(worker.calls).toEqual([]);
  });

  it("shows an up-to-date diagram, asking GitHub at most once a minute", async () => {
    await done(OLD);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
    clock += 59_000;
    await viewRepo({ owner: "Acme", repo: "SHOP" }, deps);
    expect(gh.requests).toHaveLength(2); // repo + commit, once
    clock += 2_000;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(gh.requests).toHaveLength(4);
    expect(worker.calls).toEqual([]);
  });

  it("re-analyzes a new commit once, charged to the repo, and keeps showing the old diagram", async () => {
    await done(OLD);
    shop.sha = NEW;
    const jobId = `analyze-${NEW.slice(0, 32)}`;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId }),
    );
    expect(worker.calls).toEqual([{ owner: "Acme", repo: "Shop", sha: NEW }]);
    expect(await rows()).toEqual([
      { sha: OLD, status: "done", version: VERSION },
      { sha: NEW, status: "queued", version: VERSION },
    ]);
    expect(await repoSlots()).toBe(1);

    // The next view finds it in flight: the same job back, nothing charged.
    clock += 120_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW, jobId }),
    );
    expect(await repoSlots()).toBe(1);

    // Once it's done, the new diagram is shown.
    const row = (await t.db.select().from(analyses)).find((r) => r.sha === NEW);
    await completeAnalysis(t.db, row!.id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(NEW, { state: "current" }),
    );
  });

  it("re-analyzes the same commit when the analyzer version changed", async () => {
    await done(OLD, "0.1.0");
    const view = await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(view).toEqual(
      ready(OLD, { state: "updating", sha: OLD, jobId: `analyze-${OLD.slice(0, 32)}` }, "0.1.0"),
    );
    expect(await rows()).toContainEqual({ sha: OLD, status: "queued", version: VERSION });
  });

  it("shows a newer commit's finished diagram when it's the newest by commit, not by finish", async () => {
    await done(NEW);
    await done(OLD); // an older commit analyzed later finishes last
    shop.sha = NEW;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(NEW, { state: "current" }),
    );
    expect(worker.calls).toEqual([]);
  });

  it("doesn't re-run a failed analysis of the latest commit on view", async () => {
    await done(OLD);
    const { id } = await startAnalysis(t.db, {
      repoId: await repoId(),
      sha: NEW,
      analyzerVersion: VERSION,
    });
    await failAnalysis(t.db, id, "LIMIT_FILES");
    shop.sha = NEW;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "failed" }),
    );
    expect(worker.calls).toEqual([]);
  });

  it("stops after the repo's hourly budget of re-analyses", async () => {
    await done(OLD);
    deps.rechecksPerHour = 1;
    shop.sha = NEW;
    await viewRepo({ owner: "acme", repo: "shop" }, deps);
    const third = "c".repeat(40);
    shop.sha = third;
    clock += 61_000;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: third, reason: "limited" }),
    );
    expect(worker.calls.map((c) => c.sha)).toEqual([NEW]);
    expect(RECHECKS_PER_HOUR).toBe(6);
  });

  it("gives the slot back when the worker is down or the job already existed", async () => {
    await done(OLD);
    shop.sha = NEW;
    worker.setDown(true);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "unavailable" }),
    );
    expect(await repoSlots()).toBe(0);
    expect(await rows()).toHaveLength(1);

    worker.setDown(false);
    worker.jobs.add(`analyze-${NEW.slice(0, 32)}`); // someone else's request made it
    const view = await viewRepo({ owner: "acme", repo: "shop" }, deps);
    expect(view).toMatchObject({ head: { state: "updating", sha: NEW } });
    expect(await repoSlots()).toBe(0);
  });

  it("reports a newer commit without analyzing it when no worker is configured", async () => {
    await done(OLD);
    shop.sha = NEW;
    deps.worker = undefined;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "behind", sha: NEW, reason: "unavailable" }),
    );
    // In flight already (queued by /api/analyze): updating, without a job ID.
    await startAnalysis(t.db, { repoId: await repoId(), sha: NEW, analyzerVersion: VERSION });
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW }),
    );
    // A worker that's down while the commit is in flight says the same.
    deps.worker = worker.client;
    worker.setDown(true);
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "updating", sha: NEW }),
    );
  });

  it("still shows the diagram when GitHub can't be asked, and doesn't remember the failure", async () => {
    await done(OLD);
    gh.failNext(new TypeError("fetch failed"));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "unknown" }),
    );
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
  });

  it("stops serving a repo GitHub no longer shows publicly, permalinks included (M5 review)", async () => {
    await done(OLD);
    shop.private = true;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    // Hidden in the database: the permalink, which never asks GitHub, stops too, and the
    // repo page stays "not analyzed" once GitHub shows it again, until someone asks for an
    // analysis (which restores the row; analyze.test.ts).
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
    shop.private = false;
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "acme",
      repo: "shop",
    });
    await repoId();
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual(
      ready(OLD, { state: "current" }),
    );
  });

  it("stops serving a repo GitHub blocks (451), and doesn't remember the answer", async () => {
    await done(OLD);
    gh.failNext(new Response("", { status: 451 }));
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({ status: "missing" });
    expect(await viewRepo({ owner: "acme", repo: "shop", sha: OLD }, deps)).toEqual({
      status: "missing",
    });
  });

  it("treats a name now held by a different repo as not analyzed", async () => {
    await done(OLD);
    shop.id = 9999; // the old repo was renamed away and a new one took its name
    expect(await viewRepo({ owner: "acme", repo: "shop" }, deps)).toEqual({
      status: "not-analyzed",
      owner: "Acme",
      repo: "Shop",
    });
    expect(worker.calls).toEqual([]);
  });
});

describe("createHeadCache", () => {
  const answer = (sha: string) =>
    ({
      ok: true,
      repo: {
        providerRepoId: 1,
        owner: "a",
        name: "b",
        visibility: "public",
        defaultBranch: "main",
        sha,
      },
    }) as const;

  it("forgets answers after the TTL and never keeps failures", () => {
    let now = 0;
    const cache = createHeadCache({ ttlMs: 10, now: () => now });
    cache.set("a/b", answer(OLD));
    cache.set("a/c", { ok: false, code: "GITHUB_UNAVAILABLE" });
    expect(cache.get("a/b")).toEqual(answer(OLD));
    expect(cache.get("a/c")).toBeUndefined();
    now = 10;
    expect(cache.get("a/b")).toBeUndefined();
  });

  it("drops the oldest entry past its size", () => {
    const cache = createHeadCache({ maxEntries: 2 });
    cache.set("x/1", answer(OLD));
    cache.set("x/2", answer(OLD));
    cache.set("x/1", answer(NEW)); // refreshed: now the newest
    cache.set("x/3", answer(OLD));
    expect(cache.get("x/2")).toBeUndefined();
    expect(cache.get("x/1")).toEqual(answer(NEW));
    expect(cache.get("x/3")).toEqual(answer(OLD));
  });
});

describe("graphPath", () => {
  it("encodes names into the graph route", () => {
    expect(graphPath("acme", "shop.web", OLD)).toBe(`/api/graph/acme/shop.web/${OLD}`);
  });
});
