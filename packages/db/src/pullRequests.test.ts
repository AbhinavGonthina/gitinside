import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findDiffJob,
  findPullRequest,
  pullRequests,
  queuePullRequestDiff,
  recordDiffJobResult,
  recordPullRequestCheckRun,
  recordPullRequestComment,
  recordPullRequestDiff,
  recordPullRequestHead,
  repos,
  upsertRepo,
} from "./index.js";
import { createTestDb, pgErrorCode, type TestDb } from "./testing.js";

const BASE = "a".repeat(40);
const BASE2 = "b".repeat(40);
const HEAD = "c".repeat(40);
const HEAD2 = "d".repeat(40);
const AT = new Date("2026-11-08T10:00:00Z");
const LATER = new Date("2026-11-08T10:00:05Z");
const EARLIER = new Date("2026-11-08T09:59:55Z");
const CHECK = "23514";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(pullRequests);
  await t.db.delete(repos);
});

async function setup() {
  const repo = await upsertRepo(t.db, {
    providerRepoId: 601,
    owner: "acme",
    name: "shop",
    visibility: "public",
    defaultBranch: "main",
  });
  const other = await upsertRepo(t.db, {
    providerRepoId: 602,
    owner: "acme",
    name: "api",
    visibility: "public",
    defaultBranch: "main",
  });
  return { repoId: repo.id, otherRepoId: other.id };
}

/** A pull request at (BASE, HEAD) with its diff, comment, and Check Run recorded. */
async function posted(repoId: string, number = 7) {
  await recordPullRequestHead(t.db, { repoId, number, baseSha: BASE, headSha: HEAD, headAt: AT });
  await recordPullRequestDiff(t.db, {
    repoId,
    number,
    baseSha: BASE,
    headSha: HEAD,
    diffKey: "diffs/x.json.gz",
    brokenCount: 2,
  });
  await recordPullRequestComment(t.db, { repoId, number, commentId: 9_000_000_001 });
  await recordPullRequestCheckRun(t.db, {
    repoId,
    number,
    headSha: HEAD,
    checkRunId: 9_000_000_002,
  });
}

describe("recordPullRequestHead", () => {
  it("creates the record with no diff, comment, or Check Run yet", async () => {
    const { repoId } = await setup();
    const row = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    expect(row).toMatchObject({
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
      diffKey: null,
      brokenCount: null,
      commentId: null,
      checkRunId: null,
    });
    expect(await findPullRequest(t.db, repoId, 7)).toEqual(row);
  });

  it("moves to a newer head, keeping the comment and clearing the old head's diff and Check Run", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    const row = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
    });
    expect(row).toMatchObject({
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
      diffKey: null,
      brokenCount: null,
      commentId: 9_000_000_001,
      checkRunId: null,
    });
    expect(await t.db.select().from(pullRequests)).toHaveLength(1);
  });

  it("clears the diff but keeps the head's Check Run when only the base moves", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    const row = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE2,
      headSha: HEAD,
      headAt: LATER,
    });
    expect(row).toMatchObject({
      baseSha: BASE2,
      headSha: HEAD,
      diffKey: null,
      brokenCount: null,
      commentId: 9_000_000_001,
      checkRunId: 9_000_000_002,
    });
  });

  it("keeps everything for the same pair described again (a redelivery, `reopened`)", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    const row = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: LATER,
    });
    expect(row).toMatchObject({
      headAt: LATER,
      diffKey: "diffs/x.json.gz",
      brokenCount: 2,
      commentId: 9_000_000_001,
      checkRunId: 9_000_000_002,
    });
  });

  it("ignores an event older than the one recorded, answering undefined", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    const before = await findPullRequest(t.db, repoId, 7);
    expect(
      await recordPullRequestHead(t.db, {
        repoId,
        number: 7,
        baseSha: BASE2,
        headSha: HEAD2,
        headAt: EARLIER,
      }),
    ).toBeUndefined();
    expect(await findPullRequest(t.db, repoId, 7)).toEqual(before);
  });

  it("takes an event as new as the recorded one (GitHub's times are whole seconds)", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    const row = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: AT,
    });
    expect(row?.headSha).toBe(HEAD2);
  });

  it("keeps each repo's and number's record apart", async () => {
    const { repoId, otherRepoId } = await setup();
    await posted(repoId);
    await recordPullRequestHead(t.db, {
      repoId: otherRepoId,
      number: 7,
      baseSha: BASE2,
      headSha: HEAD2,
      headAt: LATER,
    });
    await recordPullRequestHead(t.db, {
      repoId,
      number: 8,
      baseSha: BASE2,
      headSha: HEAD2,
      headAt: LATER,
    });
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ headSha: HEAD, brokenCount: 2 });
    expect(await findPullRequest(t.db, otherRepoId, 7)).toMatchObject({ headSha: HEAD2 });
    expect(await findPullRequest(t.db, repoId, 9)).toBeUndefined();
  });
});

describe("queuePullRequestDiff", () => {
  const JOB = `diff-${"e".repeat(32)}`;
  const JOB2 = `diff-${"f".repeat(32)}`;

  async function opened(repoId: string) {
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    return { repoId, number: 7, baseSha: BASE, headSha: HEAD, jobId: JOB };
  }

  it("names the job on the current pair and answers when it was queued", async () => {
    const { repoId } = await setup();
    const job = await opened(repoId);
    const queuedAt = await queuePullRequestDiff(t.db, job);
    expect(queuedAt).toBeInstanceOf(Date);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({
      diffJobId: JOB,
      diffQueuedAt: queuedAt,
    });
  });

  it("answers the same time for the same job again, so its task keeps its name", async () => {
    const { repoId } = await setup();
    const job = await opened(repoId);
    const first = await queuePullRequestDiff(t.db, job);
    // A redelivery: same pair described again, same job.
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: LATER,
    });
    expect(await queuePullRequestDiff(t.db, job)).toEqual(first);

    // Another job for the same pair (a new analyzer version) takes over with its own time.
    const replaced = await queuePullRequestDiff(t.db, { ...job, jobId: JOB2 });
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({
      diffJobId: JOB2,
      diffQueuedAt: replaced,
    });
  });

  it("queues nothing for an old pair, a recorded diff, or an unknown pull request", async () => {
    const { repoId } = await setup();
    const job = await opened(repoId);
    expect(await queuePullRequestDiff(t.db, { ...job, headSha: HEAD2 })).toBeUndefined();
    expect(await queuePullRequestDiff(t.db, { ...job, baseSha: BASE2 })).toBeUndefined();
    expect(await queuePullRequestDiff(t.db, { ...job, number: 8 })).toBeUndefined();
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ diffJobId: null });

    await recordPullRequestDiff(t.db, { ...job, diffKey: "k", brokenCount: 0 });
    expect(await queuePullRequestDiff(t.db, job)).toBeUndefined();
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ diffJobId: null });
  });

  it("is cleared with the diff when the pair moves on, and kept for the same pair", async () => {
    const { repoId } = await setup();
    const job = await opened(repoId);
    await queuePullRequestDiff(t.db, job);
    const same = await recordPullRequestHead(t.db, { ...job, headAt: LATER });
    expect(same).toMatchObject({ diffJobId: JOB });
    const moved = await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE2,
      headSha: HEAD,
      headAt: new Date("2026-11-08T10:00:10Z"),
    });
    expect(moved).toMatchObject({ diffJobId: null, diffQueuedAt: null });
  });

  it("is refused by the database with a job ID that isn't a diff job's", async () => {
    const { repoId } = await setup();
    const job = await opened(repoId);
    const analyze = { ...job, jobId: `analyze-${"e".repeat(32)}` };
    expect(await pgErrorCode(queuePullRequestDiff(t.db, analyze))).toBe(CHECK);
  });
});

describe("diff jobs by ID", () => {
  const JOB = `diff-${"e".repeat(32)}`;
  const OTHER_JOB = `diff-${"f".repeat(32)}`;

  async function queued(repoId: string, number: number, jobId = JOB) {
    await recordPullRequestHead(t.db, { repoId, number, baseSha: BASE, headSha: HEAD, headAt: AT });
    await queuePullRequestDiff(t.db, { repoId, number, baseSha: BASE, headSha: HEAD, jobId });
  }

  it("finds a queued job's repo and pair, and nothing for a job no record names", async () => {
    const { repoId } = await setup();
    await queued(repoId, 7);
    expect(await findDiffJob(t.db, JOB)).toEqual({
      repoId,
      baseSha: BASE,
      headSha: HEAD,
      status: "queued",
    });
    expect(await findDiffJob(t.db, OTHER_JOB)).toBeUndefined();
  });

  it("records the result on every record naming the job, and then reads it as done", async () => {
    const { repoId } = await setup();
    // Two pull requests with the same pair share the job; a third has its own.
    await queued(repoId, 9);
    await queued(repoId, 7);
    await queued(repoId, 8, OTHER_JOB);
    const result = { jobId: JOB, diffKey: "private/k.json.gz", brokenCount: 2 };
    const pair = { repoId, baseSha: BASE, headSha: HEAD };
    expect(await recordDiffJobResult(t.db, result)).toEqual([
      { ...pair, number: 7 },
      { ...pair, number: 9 },
    ]);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({
      diffKey: "private/k.json.gz",
      brokenCount: 2,
    });
    expect(await findPullRequest(t.db, repoId, 8)).toMatchObject({ diffKey: null });
    expect(await findDiffJob(t.db, JOB)).toMatchObject({ status: "done" });
    expect(await findDiffJob(t.db, OTHER_JOB)).toMatchObject({ status: "queued" });

    // A retried job writes the same result again and still learns where to post.
    expect(await recordDiffJobResult(t.db, result)).toHaveLength(2);
  });

  it("never lands an older job's result on a newer pair", async () => {
    const { repoId } = await setup();
    await queued(repoId, 7);
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
    });
    expect(await findDiffJob(t.db, JOB)).toBeUndefined();
    const late = { jobId: JOB, diffKey: "old", brokenCount: 3 };
    expect(await recordDiffJobResult(t.db, late)).toEqual([]);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({
      headSha: HEAD2,
      diffKey: null,
      brokenCount: null,
    });
  });

  it("prefers a live record while another sharing the job has its diff", async () => {
    const { repoId } = await setup();
    await queued(repoId, 7);
    await queued(repoId, 8);
    await recordPullRequestDiff(t.db, {
      repoId,
      number: 8,
      baseSha: BASE,
      headSha: HEAD,
      diffKey: "k",
      brokenCount: 0,
    });
    expect(await findDiffJob(t.db, JOB)).toMatchObject({ status: "queued" });
  });
});

describe("recordPullRequestDiff", () => {
  it("records the diff of the current pair", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    const diff = { repoId, number: 7, baseSha: BASE, headSha: HEAD, diffKey: "k", brokenCount: 0 };
    expect(await recordPullRequestDiff(t.db, diff)).toBe(true);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ diffKey: "k", brokenCount: 0 });
  });

  it("never lets an older head's result overwrite a newer head", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
    });
    const late = {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      diffKey: "old",
      brokenCount: 3,
    };
    expect(await recordPullRequestDiff(t.db, late)).toBe(false);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({
      headSha: HEAD2,
      diffKey: null,
      brokenCount: null,
    });
  });

  it("refuses a result for an old base too, and for a pull request never recorded", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE2,
      headSha: HEAD,
      headAt: AT,
    });
    const diff = { repoId, number: 7, baseSha: BASE, headSha: HEAD, diffKey: "k", brokenCount: 1 };
    expect(await recordPullRequestDiff(t.db, diff)).toBe(false);
    expect(await recordPullRequestDiff(t.db, { ...diff, number: 8, baseSha: BASE2 })).toBe(false);
    expect(await t.db.select().from(pullRequests)).toHaveLength(1);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ diffKey: null });
  });

  it("is refused by the database with a negative count", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    const diff = { repoId, number: 7, baseSha: BASE, headSha: HEAD, diffKey: "k", brokenCount: -1 };
    expect(await pgErrorCode(recordPullRequestDiff(t.db, diff))).toBe(CHECK);
  });
});

describe("recordPullRequestComment", () => {
  it("stores the pull request's comment whatever its head, replacing an earlier one", async () => {
    const { repoId } = await setup();
    await posted(repoId);
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
    });
    expect(await recordPullRequestComment(t.db, { repoId, number: 7, commentId: 42 })).toBe(true);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ commentId: 42 });
    expect(await recordPullRequestComment(t.db, { repoId, number: 8, commentId: 43 })).toBe(false);
  });
});

describe("recordPullRequestCheckRun", () => {
  it("stores a Check Run only for the current head", async () => {
    const { repoId } = await setup();
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD,
      headAt: AT,
    });
    const run = { repoId, number: 7, headSha: HEAD, checkRunId: 51 };
    expect(await recordPullRequestCheckRun(t.db, run)).toBe(true);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ checkRunId: 51 });
    await recordPullRequestHead(t.db, {
      repoId,
      number: 7,
      baseSha: BASE,
      headSha: HEAD2,
      headAt: LATER,
    });
    expect(await recordPullRequestCheckRun(t.db, { ...run, checkRunId: 52 })).toBe(false);
    expect(await findPullRequest(t.db, repoId, 7)).toMatchObject({ checkRunId: null });
    expect(await recordPullRequestCheckRun(t.db, { ...run, number: 8 })).toBe(false);
  });
});
