import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  analyses,
  completeAnalysis,
  deleteInstallationData,
  installations,
  queueAnalysis,
  repos,
  upsertInstallation,
  upsertRepo,
  type AnyDatabase,
  type InstallationFacts,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobRequest } from "./request.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { JobAlreadyDone, processJob, type JobDeps } from "./job.js";
import { createAnalysisRecorder, type AnalysisRecorder } from "./record.js";
import type { RunResult } from "./runner.js";
import { startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore } from "./storage.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = "analyze-0123456789abcdef0123456789abcdef";
const VERSION = "0.1.0";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const INSTALLATION: InstallationFacts = {
  githubInstallationId: 42,
  accountId: 9001,
  accountLogin: "Acme",
  accountType: "Organization",
  suspendedAt: null,
};
const INSTALLATION_TOKEN = "ghs_installation";
const GRAPH = '{"nodes":[]}\n';
const STATS = {
  files: 2,
  nodes: 5,
  edges: 4,
  unresolved: 1,
  warnings: 0,
  graphBytes: GRAPH.length,
  stageMs: { inventory: 3, graph: 1 },
  peakRssBytes: 900_000_000,
  heapBytes: 700_000_000,
  gcMs: { minor: 4100, major: 900 },
};

let t: TestDb;
let github: FakeGitHub;
let s3: FakeS3;
let root: string;
let repoJson: Record<string, unknown>;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(installations);
  repoJson = {
    id: 3_000_000_001,
    name: "Shop",
    owner: { login: "Acme" },
    private: false,
    default_branch: "main",
  };
  github = await startFakeGitHub(tarballFrom([{ name: "index.ts", body: "export {};\n" }]));
  const tarball = github.api;
  github.api = (req, res) => {
    if (req.url === "/repos/acme/shop") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(repoJson));
    } else tarball(req, res);
  };
  s3 = await startFakeS3();
  root = await mkdtemp(join(tmpdir(), "gitinside-record-"));
});

afterEach(async () => {
  await github.close();
  await s3.close();
  await rm(root, { recursive: true, force: true });
});

function recorder(db: AnyDatabase = t.db, now?: () => number): AnalysisRecorder {
  return createAnalysisRecorder({
    ...(now === undefined ? {} : { now }),
    db,
    store: createObjectStore({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      credentials: s3.credentials,
    }),
    analyzerVersion: VERSION,
    github: { apiBase: github.apiBase, token: "test-token" },
  });
}

const writeGraph = async (job: { out: string }): Promise<RunResult> => {
  await writeFile(job.out, GRAPH);
  return { ok: true, stats: STATS, durationMs: 1 };
};

function deps(r: AnalysisRecorder, overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    jobsRoot: join(root, "jobs"),
    recorder: r,
    publish: r.publish,
    download: { apiBase: github.apiBase, downloadOrigins: [github.codeloadOrigin] },
    run: writeGraph,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return error;
    throw error;
  }
  throw new Error("expected the job to fail");
}

async function onlyAnalysis() {
  const rows = await t.db.select().from(analyses);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("createAnalysisRecorder", () => {
  it("records the repo, uploads the snapshot, then marks the analysis done", async () => {
    const r = recorder();
    await processJob({ id: ID, request: REQUEST }, deps(r));

    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({
      providerRepoId: 3_000_000_001,
      owner: "Acme",
      name: "Shop",
      visibility: "public",
      defaultBranch: "main",
    });
    const row = await onlyAnalysis();
    const key = `public/acme/shop/${SHA}/${VERSION}.json.gz`;
    expect(row).toMatchObject({
      repoId: repo!.id,
      sha: SHA,
      analyzerVersion: VERSION,
      status: "done",
      snapshotKey: key,
      errorCode: null,
      jobId: ID,
      attempts: 1,
      progress: null,
    });
    const stored = s3.objects.get(key);
    expect(gunzipSync(stored!.body).toString()).toBe(GRAPH);
    expect(row.stats).toMatchObject({
      files: 2,
      nodes: 5,
      edges: 4,
      unresolved: 1,
      warnings: 0,
      graphBytes: GRAPH.length,
      snapshotBytes: stored!.body.length,
      stageMs: { inventory: 3, graph: 1 },
      peakRssBytes: 900_000_000,
      heapBytes: 700_000_000,
      gcMs: { minor: 4100, major: 900 },
    });
    // jsonb keeps its own key order, so compare as an object.
    expect(row.stats!.jobMs).toEqual({
      download: expect.any(Number) as number,
      analyze: expect.any(Number) as number,
      upload: expect.any(Number) as number,
    });
    // GitHub's repo description first, with the token; then the tarball.
    expect(github.requests[0]).toMatchObject({
      server: "api",
      url: "/repos/acme/shop",
      authorization: "Bearer test-token",
    });
  });

  it("refuses a private repo on a public job before downloading or writing anything", async () => {
    repoJson.private = true;
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps(recorder())));
    expect([error.code, error.retriable]).toEqual(["REPO_NOT_PUBLIC", false]);
    expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/shop"]);
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(s3.objects.size).toBe(0);
  });

  /** What the website writes before a job through installation 42: the linked repo, its row. */
  async function queuedThroughInstallation(visibility: "public" | "private"): Promise<string> {
    const installation = await upsertInstallation(t.db, INSTALLATION);
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: 3_000_000_001,
      owner: "Acme",
      name: "Shop",
      visibility,
      defaultBranch: "main",
      githubInstallationId: 42,
    });
    await queueAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION }, { jobId: ID });
    return installation;
  }

  it("stores a private repo's job under its installation and repo ID, linking the repo", async () => {
    repoJson.private = true;
    const installation = await queuedThroughInstallation("private");
    const request = { ...REQUEST, installationId: 42 };
    const asks: unknown[] = [];
    await processJob(
      { id: ID, request },
      deps(recorder(), {
        installationToken: async (ask) => {
          asks.push(ask);
          return INSTALLATION_TOKEN;
        },
      }),
    );
    expect(asks).toEqual([{ jobId: ID, installationId: 42 }]);
    // The facts and the tarball with the installation's token, never the worker's own.
    expect(github.requests.map((r) => [r.server, r.authorization])).toEqual([
      ["api", `Bearer ${INSTALLATION_TOKEN}`],
      ["api", `Bearer ${INSTALLATION_TOKEN}`],
      ["codeload", undefined],
    ]);
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({ visibility: "private", installationId: installation });
    const key = `private/42/${repo!.id}/${SHA}/${VERSION}.json.gz`;
    expect((await onlyAnalysis()).snapshotKey).toBe(key);
    const stored = [...s3.objects.values()][0];
    expect(stored?.headers["cache-control"] ?? "").not.toContain("public");
  });

  it("keeps a public repo read through an installation linked, and a later public job too", async () => {
    const installation = await queuedThroughInstallation("public");
    await processJob(
      { id: ID, request: { ...REQUEST, installationId: 42 } },
      deps(recorder(), { installationToken: async () => INSTALLATION_TOKEN }),
    );
    await t.db.delete(analyses);
    await processJob({ id: ID, request: REQUEST }, deps(recorder()));
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({ visibility: "public", installationId: installation });
  });

  it("fails a job whose installation isn't stored as the permanent INSTALLATION_NOT_FOUND", async () => {
    repoJson.private = true;
    const request = { ...REQUEST, installationId: 42 };
    const error = await failure(
      processJob(
        { id: ID, request },
        deps(recorder(), { installationToken: async () => INSTALLATION_TOKEN }),
      ),
    );
    expect([error.code, error.retriable]).toEqual(["INSTALLATION_NOT_FOUND", false]);
    expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/shop"]);
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(s3.objects.size).toBe(0);
  });

  describe("an installation's data deleted around the job (M8.5b)", () => {
    const request = { ...REQUEST, installationId: 42 };
    const withToken = (overrides: Partial<JobDeps> = {}) =>
      deps(recorder(), { installationToken: async () => INSTALLATION_TOKEN, ...overrides });

    it("refuses to start once the repo was removed, re-creating nothing", async () => {
      repoJson.private = true;
      await queuedThroughInstallation("private");
      // The token was minted, then the webhook deleted the repo before the start.
      await deleteInstallationData(t.db, 42, [3_000_000_001]);
      const error = await failure(processJob({ id: ID, request }, withToken()));
      expect([error.code, error.retriable]).toEqual(["REPO_NOT_INSTALLED", false]);
      expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/shop"]);
      expect(await t.db.select().from(repos)).toEqual([]);
      expect(await t.db.select().from(analyses)).toEqual([]);
      expect(s3.objects.size).toBe(0);
    });

    it("fails a public repo's queued row once it was unlinked, linking nothing again", async () => {
      await queuedThroughInstallation("public");
      await deleteInstallationData(t.db, 42, [3_000_000_001]);
      const error = await failure(processJob({ id: ID, request }, withToken()));
      expect(error.code).toBe("REPO_NOT_INSTALLED");
      expect(await onlyAnalysis()).toMatchObject({
        status: "failed",
        errorCode: "REPO_NOT_INSTALLED",
      });
      const [repo] = await t.db.select().from(repos);
      expect(repo?.installationId).toBeNull();
    });

    it("deletes a private snapshot at once when the row was deleted while the job ran", async () => {
      repoJson.private = true;
      await queuedThroughInstallation("private");
      const run: JobDeps["run"] = async (child) => {
        await deleteInstallationData(t.db, 42, "all");
        return writeGraph(child);
      };
      const error = await failure(processJob({ id: ID, request }, withToken({ run })));
      expect([error.code, error.retriable]).toEqual(["REPO_NOT_INSTALLED", false]);
      // Uploaded, then deleted: nothing names it, nothing keeps it.
      expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
      expect(s3.objects.size).toBe(0);
      expect(await t.db.select().from(repos)).toEqual([]);
      expect(await t.db.select().from(analyses)).toEqual([]);
    });

    it("still fails the job when that delete fails, leaving the object to retention", async () => {
      repoJson.private = true;
      await queuedThroughInstallation("private");
      const put = s3.handler;
      s3.handler = (req, body, res) => {
        if (req.method === "DELETE") {
          res.writeHead(503);
          res.end();
        } else put(req, body, res);
      };
      const run: JobDeps["run"] = async (child) => {
        await deleteInstallationData(t.db, 42, "all");
        return writeGraph(child);
      };
      const error = await failure(processJob({ id: ID, request }, withToken({ run })));
      expect([error.code, error.retriable]).toEqual(["REPO_NOT_INSTALLED", false]);
      expect(error.detail).toMatch(/deleting its snapshot failed/);
      expect(s3.objects.size).toBe(1);
    });

    it("keeps the object when the row is already done under the same key", async () => {
      repoJson.private = true;
      await queuedThroughInstallation("private");
      const r = recorder();
      const run: JobDeps["run"] = async (child) => {
        // Another attempt finished first; this one's upload repeats the same immutable key.
        const row = await onlyAnalysis();
        const [repo] = await t.db.select().from(repos);
        const key = `private/42/${repo!.id}/${SHA}/${VERSION}.json.gz`;
        await completeAnalysis(t.db, row.id, { snapshotKey: key, stats: STATS });
        return writeGraph(child);
      };
      await processJob(
        { id: ID, request },
        deps(r, { installationToken: async () => INSTALLATION_TOKEN, run }),
      );
      expect(s3.objects.size).toBe(1);
      expect((await onlyAnalysis()).status).toBe("done");
    });
  });

  describe("a failure before the start", () => {
    async function queuedRow(): Promise<string> {
      const { id: repoId } = await upsertRepo(t.db, {
        providerRepoId: 3_000_000_001,
        owner: "Acme",
        name: "Shop",
        visibility: "private",
        defaultBranch: "main",
      });
      const { id } = await queueAnalysis(
        t.db,
        { repoId, sha: SHA, analyzerVersion: VERSION },
        { jobId: ID },
      );
      return id;
    }
    const refused = (code: string) => async (): Promise<string> => {
      throw new JobFailure(code, "the website answered");
    };
    const request = { ...REQUEST, installationId: 42 };

    it("fails the queued row with a refused token's code, before asking GitHub anything", async () => {
      await queuedRow();
      const error = await failure(
        processJob(
          { id: ID, request },
          deps(recorder(), { installationToken: refused("INSTALLATION_SUSPENDED") }),
        ),
      );
      expect([error.code, error.retriable]).toEqual(["INSTALLATION_SUSPENDED", false]);
      expect(github.requests).toEqual([]);
      expect(await onlyAnalysis()).toMatchObject({
        status: "failed",
        errorCode: "INSTALLATION_SUSPENDED",
        attempts: 0,
      });
    });

    it("leaves the row queued for a retry, and fails it on the last attempt", async () => {
      await queuedRow();
      const unavailable = deps(recorder(), { installationToken: refused("TOKEN_UNAVAILABLE") });
      const first = await failure(processJob({ id: ID, request }, unavailable));
      expect([first.code, first.retriable]).toEqual(["TOKEN_UNAVAILABLE", true]);
      expect(await onlyAnalysis()).toMatchObject({ status: "queued", errorCode: null });

      await failure(processJob({ id: ID, request, lastAttempt: true }, unavailable));
      expect(await onlyAnalysis()).toMatchObject({
        status: "failed",
        errorCode: "TOKEN_UNAVAILABLE",
      });
    });

    it("fails the queued row when GitHub doesn't show the repo", async () => {
      await queuedRow();
      github.api = (_req, res) => {
        res.writeHead(404);
        res.end();
      };
      const error = await failure(processJob({ id: ID, request: REQUEST }, deps(recorder())));
      expect(error.code).toBe("REPO_NOT_FOUND");
      expect(await onlyAnalysis()).toMatchObject({ status: "failed", errorCode: "REPO_NOT_FOUND" });
    });
  });

  it("marks a permanent failure failed with its code, and nothing is uploaded", async () => {
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code: "LIMIT_FILES",
      message: "LIMIT_FILES",
      stderrTail: "",
      durationMs: 1,
    });
    await failure(processJob({ id: ID, request: REQUEST }, deps(recorder(), { run })));
    expect(await onlyAnalysis()).toMatchObject({ status: "failed", errorCode: "LIMIT_FILES" });
    expect(s3.objects.size).toBe(0);
  });

  it("puts a retriable failure back in the queue, and the retry finishes the same row", async () => {
    s3.handler = (_req, _body, res) => {
      res.writeHead(503);
      res.end();
    };
    const r = recorder();
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps(r)));
    expect(error.code).toBe("PUBLISH_FAILED");
    const queued = await onlyAnalysis();
    expect(queued.status).toBe("queued");

    const fresh = await startFakeS3();
    const healthy = createAnalysisRecorder({
      db: t.db,
      store: createObjectStore({
        endpoint: fresh.endpoint,
        bucket: fresh.bucket,
        credentials: fresh.credentials,
      }),
      analyzerVersion: VERSION,
      github: { apiBase: github.apiBase },
    });
    await processJob({ id: ID, request: REQUEST }, deps(healthy));
    await fresh.close();
    expect(await onlyAnalysis()).toMatchObject({ id: queued.id, status: "done", attempts: 2 });
  });

  it("writes progress to the running row under the job's ID (ADR-0139)", async () => {
    const r = recorder();
    const seen: unknown[] = [];
    const run: JobDeps["run"] = async (child) => {
      await r.progress?.(ID, { stage: "analyze", progress: 38, step: "programs", count: 2 });
      seen.push((await onlyAnalysis()).progress);
      return writeGraph(child);
    };
    await processJob({ id: ID, request: REQUEST }, deps(r, { run }));
    expect(seen).toEqual([{ stage: "analyze", progress: 38, step: "programs", count: 2 }]);
    // Once done there's nothing to show, and a late write changes nothing.
    await r.progress?.(ID, { stage: "upload", progress: 90 });
    expect((await onlyAnalysis()).progress).toBeNull();
  });

  it("writes the estimate as the time left now on the worker's clock, never its `since` (ADR-0140)", async () => {
    const r = recorder(t.db, () => 25_500);
    const seen: unknown[] = [];
    const run: JobDeps["run"] = async (child) => {
      const calls = { stage: "analyze" as const, progress: 70, step: "calls" as const };
      await r.progress?.(ID, { ...calls, since: 10_000, expectMs: 30_000 });
      const row = await onlyAnalysis();
      seen.push(row.progress, row.progressAt instanceof Date);
      return writeGraph(child);
    };
    await processJob({ id: ID, request: REQUEST }, deps(r, { run }));
    expect(seen).toEqual([{ stage: "analyze", progress: 70, step: "calls", leftMs: 14_500 }, true]);
  });

  it("fails the start as the retriable RECORD_FAILED when the database is down", async () => {
    const down = {
      transaction: async () => {
        throw new Error("connection refused");
      },
    } as unknown as AnyDatabase;
    const error = await failure(processJob({ id: ID, request: REQUEST }, deps(recorder(down))));
    expect([error.code, error.retriable]).toEqual(["RECORD_FAILED", true]);
    expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/shop"]);
  });

  it("says a job is done only once its row is `done` (M5.17c2b)", async () => {
    const r = recorder();
    expect(await r.done?.(ID)).toBe(false);
    const run = async (): Promise<RunResult> => ({
      ok: false,
      code: "LIMIT_FILES",
      message: "LIMIT_FILES",
      stderrTail: "",
      durationMs: 1,
    });
    await failure(processJob({ id: ID, request: REQUEST }, deps(r, { run })));
    expect((await onlyAnalysis()).status).toBe("failed");
    expect(await r.done?.(ID)).toBe(false);

    const seen: (boolean | undefined)[] = [];
    const running: JobDeps["run"] = async (child) => {
      seen.push(await r.done?.(ID));
      return writeGraph(child);
    };
    await processJob({ id: ID, request: REQUEST }, deps(r, { run: running }));
    expect(seen).toEqual([false]);
    expect(await r.done?.(ID)).toBe(true);
    expect(await r.done?.(`analyze-${"f".repeat(32)}`)).toBe(false);
  });

  it("stops before the download when the start finds the row already `done` (R9)", async () => {
    await processJob({ id: ID, request: REQUEST }, deps(recorder()));
    const finished = await onlyAnalysis();
    github.requests.length = 0;
    // A second push that `POST /run`'s `done` check missed (a race, or a failed lookup).
    let runs = 0;
    const run: JobDeps["run"] = async (child) => {
      runs++;
      return writeGraph(child);
    };
    await expect(
      processJob({ id: ID, request: REQUEST }, deps(recorder(), { run })),
    ).rejects.toBeInstanceOf(JobAlreadyDone);
    expect(github.requests.map((r) => r.url)).toEqual(["/repos/acme/shop"]);
    expect(runs).toBe(0);
    expect(s3.objects.size).toBe(1);
    expect(await onlyAnalysis()).toEqual(finished);
  });

  it("refuses to publish a job that was never recorded", async () => {
    const unrecorded = deps(recorder());
    delete unrecorded.recorder;
    const error = await failure(processJob({ id: ID, request: REQUEST }, unrecorded));
    expect(error.code).toBe("PUBLISH_FAILED");
    expect((error.cause as Error).message).toBe("the job was not recorded");
  });
});
