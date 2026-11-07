// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  computeUsage,
  computeUsageThisMonth,
  failAnalysis,
  installations,
  queueAnalysis,
  repos,
  requeueAnalysis,
  startAnalysis,
  upsertInstallation,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { taskIdFor } from "./cloudTasks";
import {
  InstallationRefusedError,
  QUEUE_UNAVAILABLE,
  enqueueAnalysis,
  type EnqueueDeps,
  type QueueRepo,
} from "./enqueue";
import { fakeTaskQueue } from "./google.testkit";
import type { ResolvedRepo } from "./github";

const SECRET = "q".repeat(43);
const VERSION = "0.1.0";
const SHA = "d".repeat(40);
const REPO: ResolvedRepo = {
  providerRepoId: 5150,
  owner: "Acme",
  name: "Shop",
  visibility: "public",
  defaultBranch: "main",
  sha: SHA,
};
/** The worker's own ID for this commit (its main entry, not the web's light one). */
const JOB_ID = jobIdFor({ kind: "analyze", owner: "acme", repo: "shop", sha: SHA }, VERSION);

let t: TestDb;
let tasks: ReturnType<typeof fakeTaskQueue>;
let deps: EnqueueDeps;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(installations);
  await t.db.delete(computeUsage);
  tasks = fakeTaskQueue(SECRET);
  deps = { db: t.db, queue: tasks.queue, analyzerVersion: VERSION };
});

async function rows() {
  return t.db
    .select({
      id: analyses.id,
      status: analyses.status,
      jobId: analyses.jobId,
      errorCode: analyses.errorCode,
      queuedAt: analyses.queuedAt,
    })
    .from(analyses);
}

async function repoId() {
  return (await upsertRepo(t.db, REPO)).id;
}

describe("enqueueAnalysis", () => {
  it("writes the queued row, then a task named from its queue entry", async () => {
    expect(await enqueueAnalysis(REPO, deps)).toEqual({
      status: "queued",
      jobId: JOB_ID,
      entered: true,
    });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "queued", jobId: JOB_ID, errorCode: null });
    expect(tasks.taskIds()).toEqual([taskIdFor(JOB_ID, row!.queuedAt)]);
    expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "Acme", repo: "Shop", sha: SHA }]);
  });

  it("a second request for the same entry makes no second task", async () => {
    await enqueueAnalysis(REPO, deps);
    expect(await enqueueAnalysis({ ...REPO, owner: "ACME" }, deps)).toEqual({
      status: "queued",
      jobId: JOB_ID,
      entered: false,
    });
    expect(tasks.google.tasks).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("racing requests for a new commit create one task", async () => {
    const answers = await Promise.all([1, 2, 3].map(() => enqueueAnalysis(REPO, deps)));
    expect(answers.filter((a) => a.status === "queued" && a.entered)).toHaveLength(1);
    expect(tasks.google.tasks).toHaveLength(1);
  });

  it("a running or done commit gets no task", async () => {
    const key = { repoId: await repoId(), sha: SHA, analyzerVersion: VERSION };
    const { id } = await startAnalysis(t.db, key, { jobId: JOB_ID });
    expect(await enqueueAnalysis(REPO, deps)).toEqual({
      status: "running",
      jobId: JOB_ID,
      entered: false,
    });
    await completeAnalysis(t.db, id, {
      snapshotKey: "k",
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect(await enqueueAnalysis(REPO, deps)).toEqual({ status: "done" });
    expect(tasks.google.tasks).toEqual([]);
  });

  it("a failed job queued again gets a fresh task name (Google keeps used ones a day)", async () => {
    await enqueueAnalysis(REPO, deps);
    const [first] = await rows();
    // The job ran and failed; its task's name stays taken. (Names hold milliseconds.)
    await new Promise((resolve) => setTimeout(resolve, 5));
    await failAnalysis(t.db, first!.id, "DOWNLOAD_FAILED");

    expect(await enqueueAnalysis(REPO, deps)).toMatchObject({ status: "queued", entered: true });
    const [again] = await rows();
    expect(tasks.taskIds()).toEqual([
      taskIdFor(JOB_ID, first!.queuedAt),
      taskIdFor(JOB_ID, again!.queuedAt),
    ]);
    expect(tasks.google.tasks).toHaveLength(2);
  });

  it("a row waiting for its retry gets no second task, and costs no operation (R1)", async () => {
    await enqueueAnalysis(REPO, deps);
    const [first] = await rows();
    // The task's first attempt failed retriably: the worker put the row back in the queue,
    // and Cloud Tasks will push the same task again after its backoff.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const key = { repoId: await repoId(), sha: SHA, analyzerVersion: VERSION };
    await startAnalysis(t.db, key, { jobId: JOB_ID });
    await requeueAnalysis(t.db, first!.id);

    expect(await enqueueAnalysis(REPO, deps)).toEqual({
      status: "queued",
      jobId: JOB_ID,
      entered: false,
    });
    expect(tasks.taskIds()).toEqual([taskIdFor(JOB_ID, first!.queuedAt)]);
    expect((await computeUsageThisMonth(t.db)).taskOperations).toBe(1);
  });

  it("a retry that failed for good is queued again with a fresh task", async () => {
    await enqueueAnalysis(REPO, deps);
    const [first] = await rows();
    const key = { repoId: await repoId(), sha: SHA, analyzerVersion: VERSION };
    await startAnalysis(t.db, key, { jobId: JOB_ID });
    await requeueAnalysis(t.db, first!.id);
    await startAnalysis(t.db, key, { jobId: JOB_ID });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await failAnalysis(t.db, first!.id, "DOWNLOAD_FAILED");

    expect(await enqueueAnalysis(REPO, deps)).toMatchObject({ status: "queued", entered: true });
    expect(tasks.google.tasks).toHaveLength(2);
  });

  it("fails the row it queued when the task can't be created, and the next request retries", async () => {
    tasks.setDown(true);
    expect(await enqueueAnalysis(REPO, deps)).toEqual({ status: "unavailable" });
    expect(await rows()).toMatchObject([{ status: "failed", errorCode: QUEUE_UNAVAILABLE }]);

    tasks.setDown(false);
    expect(await enqueueAnalysis(REPO, deps)).toMatchObject({ status: "queued", entered: true });
    expect(await rows()).toMatchObject([{ status: "queued", errorCode: null }]);
    expect(tasks.google.tasks).toHaveLength(1);
  });

  it("leaves a row another request queued as it is when the queue is down", async () => {
    await queueAnalysis(
      t.db,
      { repoId: await repoId(), sha: SHA, analyzerVersion: VERSION },
      { jobId: JOB_ID },
    );
    tasks.setDown(true);
    expect(await enqueueAnalysis(REPO, deps)).toEqual({ status: "unavailable" });
    expect(await rows()).toMatchObject([{ status: "queued", errorCode: null }]);
  });

  it("counts each create call as a Cloud Tasks operation, a duplicate or refused one too (M5.18d)", async () => {
    await enqueueAnalysis(REPO, deps);
    await enqueueAnalysis(REPO, deps); // ALREADY_EXISTS: still a call
    expect((await computeUsageThisMonth(t.db)).taskOperations).toBe(2);
    tasks.setDown(true);
    await t.db.delete(analyses);
    expect(await enqueueAnalysis(REPO, deps)).toEqual({ status: "unavailable" });
    expect((await computeUsageThisMonth(t.db)).taskOperations).toBe(3);
  });

  it("queues as usual when the count fails, logging the error's name only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());
    // Every other write goes through; only the count's insert fails.
    const db = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property !== "insert") return Reflect.get(target, property, receiver) as unknown;
        return (table: unknown) => {
          if (table === computeUsage) throw new Error("postgres://user:secret@host/db is down");
          return target.insert(table as typeof analyses);
        };
      },
    });
    expect(await enqueueAnalysis(REPO, { ...deps, db })).toMatchObject({
      status: "queued",
      entered: true,
    });
    expect(errors.mock.calls).toEqual([
      [JSON.stringify({ event: "compute_count_failed", error: "Error" })],
    ]);
  });

  it("fails the row it queued on an unexpected error too, then rethrows", async () => {
    const broken: EnqueueDeps = {
      ...deps,
      queue: {
        createTask: async () => {
          throw new Error("bug");
        },
      },
    };
    await expect(enqueueAnalysis(REPO, broken)).rejects.toThrow("bug");
    expect(await rows()).toMatchObject([{ status: "failed", errorCode: QUEUE_UNAVAILABLE }]);
  });
});

describe("enqueueAnalysis through an installation (M8.3c2, ADR-0227)", () => {
  const INSTALLATION = {
    githubInstallationId: 41,
    accountId: 9001,
    accountLogin: "Acme",
    accountType: "Organization" as const,
    suspendedAt: null,
  };
  const PRIVATE: QueueRepo = { ...REPO, visibility: "private", installationId: 41 };
  const PRIVATE_JOB_ID = jobIdFor(
    { kind: "analyze", owner: "acme", repo: "shop", sha: SHA, installationId: 41 },
    VERSION,
  );

  async function refusal(repo: QueueRepo): Promise<unknown> {
    return enqueueAnalysis(repo, deps).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("carries the installation into the task, scopes the job ID, and links the repo", async () => {
    const installationRow = await upsertInstallation(t.db, INSTALLATION);
    expect(PRIVATE_JOB_ID).not.toBe(JOB_ID);
    expect(await enqueueAnalysis(PRIVATE, deps)).toEqual({
      status: "queued",
      jobId: PRIVATE_JOB_ID,
      entered: true,
    });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "queued", jobId: PRIVATE_JOB_ID });
    expect(tasks.taskIds()).toEqual([taskIdFor(PRIVATE_JOB_ID, row!.queuedAt)]);
    expect(tasks.jobs()).toEqual([
      { kind: "analyze", owner: "Acme", repo: "Shop", sha: SHA, installationId: 41 },
    ]);
    expect(
      await t.db
        .select({ visibility: repos.visibility, installationId: repos.installationId })
        .from(repos),
    ).toEqual([{ visibility: "private", installationId: installationRow }]);
  });

  it("refuses a suspended installation before writing anything", async () => {
    await upsertInstallation(t.db, { ...INSTALLATION, suspendedAt: new Date() });
    const error = await refusal(PRIVATE);
    expect(error).toBeInstanceOf(InstallationRefusedError);
    expect(error).toMatchObject({ code: "INSTALLATION_SUSPENDED" });
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("refuses an installation that isn't stored before writing anything", async () => {
    const error = await refusal(PRIVATE);
    expect(error).toBeInstanceOf(InstallationRefusedError);
    expect(error).toMatchObject({ code: "INSTALLATION_NOT_FOUND" });
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("refuses when the installation is deleted between the check and the repo's write", async () => {
    await upsertInstallation(t.db, INSTALLATION);
    // The check reads the row; the repo's write then finds it gone (M8.5's deletion).
    const db = new Proxy(t.db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver) as unknown;
        return async (...args: Parameters<typeof target.transaction>) => {
          await target.delete(installations);
          return target.transaction(...args);
        };
      },
    });
    const error = await enqueueAnalysis(PRIVATE, { ...deps, db }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INSTALLATION_NOT_FOUND" });
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("follows a commit already in flight under another job ID, creating no task", async () => {
    await upsertInstallation(t.db, INSTALLATION);
    // Queued without the installation (the repo was public then), not started yet.
    await enqueueAnalysis(REPO, deps);
    expect(await enqueueAnalysis(PRIVATE, deps)).toEqual({
      status: "queued",
      jobId: JOB_ID,
      entered: false,
    });
    const key = { repoId: await repoId(), sha: SHA, analyzerVersion: VERSION };
    await startAnalysis(t.db, key, { jobId: JOB_ID });
    expect(await enqueueAnalysis(PRIVATE, deps)).toEqual({
      status: "running",
      jobId: JOB_ID,
      entered: false,
    });
    expect(tasks.google.tasks).toHaveLength(1);
  });
});
