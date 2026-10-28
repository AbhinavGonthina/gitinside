import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { analyses, repos, type AnyDatabase } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobRequest } from "./api.js";
import { JobFailure } from "./failure.js";
import { startFakeGitHub, tarballFrom, type FakeGitHub } from "./github.testkit.js";
import { processJob, type JobDeps } from "./job.js";
import { createAnalysisRecorder, type AnalysisRecorder } from "./record.js";
import type { RunResult } from "./runner.js";
import { startFakeS3, type FakeS3 } from "./s3.testkit.js";
import { createObjectStore } from "./storage.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ID = "analyze-0123456789abcdef0123456789abcdef";
const VERSION = "0.1.0";
const REQUEST: JobRequest = { kind: "analyze", owner: "acme", repo: "shop", sha: SHA };
const GRAPH = '{"nodes":[]}\n';
const STATS = {
  files: 2,
  nodes: 5,
  edges: 4,
  unresolved: 1,
  warnings: 0,
  graphBytes: GRAPH.length,
  stageMs: { inventory: 3, graph: 1 },
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

function recorder(db: AnyDatabase = t.db): AnalysisRecorder {
  return createAnalysisRecorder({
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

  it("stores a private repo's job under its installation and repo ID", async () => {
    repoJson.private = true;
    const request = { ...REQUEST, installationId: 42 };
    await processJob({ id: ID, request }, deps(recorder()));
    const [repo] = await t.db.select().from(repos);
    expect(repo?.visibility).toBe("private");
    const key = `private/42/${repo!.id}/${SHA}/${VERSION}.json.gz`;
    expect((await onlyAnalysis()).snapshotKey).toBe(key);
    const stored = [...s3.objects.values()][0];
    expect(stored?.headers["cache-control"] ?? "").not.toContain("public");
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
    expect(await onlyAnalysis()).toMatchObject({ id: queued.id, status: "done" });
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

  it("refuses to publish a job that was never recorded", async () => {
    const unrecorded = deps(recorder());
    delete unrecorded.recorder;
    const error = await failure(processJob({ id: ID, request: REQUEST }, unrecorded));
    expect(error.code).toBe("PUBLISH_FAILED");
    expect((error.cause as Error).message).toBe("the job was not recorded");
  });
});
