// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  failAnalysis,
  queueAnalysis,
  repos,
  startAnalysis,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { taskIdFor } from "./cloudTasks";
import { QUEUE_UNAVAILABLE, enqueueAnalysis, type EnqueueDeps } from "./enqueue";
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
