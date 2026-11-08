// @vitest-environment node
import { createHmac } from "node:crypto";
import {
  analyses,
  computeUsage,
  computeUsageThisMonth,
  findInstallation,
  findPullRequest,
  installations,
  pullRequests,
  recordPullRequestDiff,
  repos,
  upsertInstallation,
  upsertRepo,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker/request";
import type { ListedObject, ObjectStore } from "@gitinside/worker/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { taskIdFor, type TaskQueue } from "./cloudTasks";
import {
  handleWebhook,
  MAX_WEBHOOK_BYTES,
  purgeObjects,
  verifySignature,
  type WebhookDeps,
} from "./githubWebhook";
import { WorkerUnavailableError, type TaskJob } from "./worker";

const SECRET = "w".repeat(43);
const PREVIOUS = "p".repeat(43);

/** A bucket in memory: listing by prefix in key order, deletes of missing keys succeed. */
class FakeStore implements Pick<ObjectStore, "list" | "delete"> {
  keys = new Set<string>();
  failList = new Set<string>();
  failDelete = new Set<string>();

  async *list(prefix = ""): AsyncIterable<ListedObject> {
    await Promise.resolve();
    if (this.failList.has(prefix)) throw new Error("LIST answered 503");
    for (const key of [...this.keys].sort()) {
      if (key.startsWith(prefix)) yield { key, size: 1, lastModified: new Date(0) };
    }
  }

  async delete(key: string): Promise<void> {
    await Promise.resolve();
    if (this.failDelete.has(key)) throw new Error("DELETE answered 500");
    this.keys.delete(key);
  }
}

/** Cloud Tasks in memory: a used name is `created: false`; `fail` makes the next creates throw. */
class FakeQueue implements Pick<TaskQueue, "createTask"> {
  tasks: { job: TaskJob; taskId: string }[] = [];
  calls = 0;
  fail: Error | undefined;

  async createTask(job: TaskJob, taskId: string): Promise<{ created: boolean }> {
    await Promise.resolve();
    this.calls++;
    if (this.fail !== undefined) throw this.fail;
    if (this.tasks.some((task) => task.taskId === taskId)) return { created: false };
    this.tasks.push({ job, taskId });
    return { created: true };
  }
}

const VERSION = "0.1.0";

let t: TestDb;
let deps: WebhookDeps;
let store: FakeStore;
let queue: FakeQueue;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(repos);
  await t.db.delete(installations);
  await t.db.delete(computeUsage);
  store = new FakeStore();
  queue = new FakeQueue();
  deps = { db: t.db, store, secrets: [SECRET], queue, analyzerVersion: VERSION };
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  logged = () =>
    spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  onTestFinished(() => spy.mockRestore());
});

/** The `github_webhook` lines logged so far in this test. */
let logged: () => Record<string, unknown>[];

const sign = (body: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function delivery(
  event: string,
  payload: unknown,
  { secret = SECRET, signature }: { secret?: string; signature?: string | null } = {},
): Request {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  };
  const sig = signature === undefined ? sign(body, secret) : signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return new Request("https://gitinside.test/api/github/webhook", {
    method: "POST",
    headers,
    body,
  });
}

const INSTALLATION = {
  id: 41,
  account: { id: 9001, login: "octo-org", type: "Organization" },
  repository_selection: "selected",
  suspended_at: null,
};

const installed = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  installation: INSTALLATION,
  sender: { id: 7, login: "octo" },
  ...extra,
});

async function answer(request: Request, ...d: [WebhookDeps | undefined] | []) {
  const response = await handleWebhook(request, d.length === 0 ? deps : d[0]);
  return { status: response.status, body: (await response.json()) as unknown };
}

function repo(providerRepoId: number, visibility: "public" | "private" = "private") {
  return upsertRepo(t.db, {
    providerRepoId,
    owner: "octo-org",
    name: `r${providerRepoId}`,
    visibility,
    defaultBranch: "main",
  });
}

const SHA = "c".repeat(40);

/** A `done` analysis stored under `key`, with its object in the fake bucket. */
async function stored(repoId: string, key: string, analyzerVersion = "0.1.0"): Promise<void> {
  await t.db.insert(analyses).values({
    repoId,
    sha: SHA,
    analyzerVersion,
    status: "done",
    snapshotKey: key,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  store.keys.add(key);
}

const linkRepo = (id: number) =>
  answer(
    delivery("installation_repositories", installed("added", { repositories_added: [{ id }] })),
  );

async function storedKeys(): Promise<string[]> {
  return (await t.db.select().from(analyses)).map((a) => a.snapshotKey ?? "").sort();
}

const installation41 = () =>
  upsertInstallation(t.db, {
    githubInstallationId: 41,
    accountId: 9001,
    accountLogin: "octo-org",
    accountType: "Organization",
    suspendedAt: null,
  });

async function linked(): Promise<Record<string, boolean>> {
  const rows = await t.db
    .select({ name: repos.name, installationId: repos.installationId })
    .from(repos);
  return Object.fromEntries(rows.map((r) => [r.name, r.installationId !== null]));
}

describe("verifySignature", () => {
  const body = new TextEncoder().encode('{"zen":"Keep it logically awesome."}');

  it("accepts GitHub's HMAC-SHA256 of the raw bytes under any configured secret", () => {
    expect(verifySignature([SECRET], body, sign(body))).toBe(true);
    expect(verifySignature([SECRET, PREVIOUS], body, sign(body, PREVIOUS))).toBe(true);
  });

  it("refuses another secret, other bytes, and malformed headers", () => {
    expect(verifySignature([SECRET], body, sign(body, PREVIOUS))).toBe(false);
    expect(verifySignature([SECRET], body, sign(new TextEncoder().encode("{}")))).toBe(false);
    const hex = sign(body).slice("sha256=".length);
    for (const header of [
      null,
      "",
      hex,
      `sha1=${hex}`,
      `sha256=${hex.toUpperCase()}`,
      `sha256=${hex.slice(2)}`,
      `sha256=${hex}00`,
      ` sha256=${hex}`,
    ]) {
      expect(verifySignature([SECRET], body, header), String(header)).toBe(false);
    }
    expect(verifySignature([], body, sign(body))).toBe(false);
  });
});

describe("purgeObjects", () => {
  it("deletes every object under each prefix and nothing else", async () => {
    for (let i = 0; i < 25; i++) store.keys.add(`private/41/a/${String(i).padStart(2, "0")}`);
    store.keys.add("private/41/b/1");
    store.keys.add("private/41/c/1");
    expect(await purgeObjects(store, ["private/41/a/", "private/41/b/"])).toEqual({
      deleted: 26,
      failed: 0,
    });
    expect([...store.keys]).toEqual(["private/41/c/1"]);
    expect(await purgeObjects(store, [])).toEqual({ deleted: 0, failed: 0 });
  });

  it("counts a failed listing or delete and goes on with the rest", async () => {
    for (const key of ["p/a/1", "p/a/2", "p/b/1", "p/c/1"]) store.keys.add(key);
    store.failList.add("p/b/");
    store.failDelete.add("p/a/1");
    expect(await purgeObjects(store, ["p/a/", "p/b/", "p/c/"])).toEqual({ deleted: 2, failed: 2 });
    expect([...store.keys].sort()).toEqual(["p/a/1", "p/b/1"]);
  });
});

describe("handleWebhook", () => {
  it("is unavailable without its configuration, and reads nothing", async () => {
    const request = delivery("installation", installed("created"));
    expect(await answer(request, undefined)).toEqual({
      status: 503,
      body: { error: "UNAVAILABLE" },
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a delivery without a valid signature before parsing it", async () => {
    for (const signature of [null, sign("{}"), sign("x", PREVIOUS)]) {
      expect(await answer(delivery("installation", installed("created"), { signature }))).toEqual({
        status: 401,
        body: { error: "BAD_SIGNATURE" },
      });
    }
    const request = new Request("https://gitinside.test/api/github/webhook", {
      method: "POST",
      headers: { "x-github-event": "installation", "x-hub-signature-256": sign("not json") },
      body: "not json",
    });
    expect((await answer(request)).status).toBe(400); // signed garbage is parsed, then refused
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("accepts the previous secret during a rotation", async () => {
    const rotating = { ...deps, secrets: [SECRET, PREVIOUS] };
    const request = delivery("installation", installed("created"), { secret: PREVIOUS });
    expect(await answer(request, rotating)).toEqual({ status: 200, body: { status: "ok" } });
    expect(await answer(delivery("ping", {}, { secret: PREVIOUS }))).toEqual({
      status: 401,
      body: { error: "BAD_SIGNATURE" },
    });
  });

  it("refuses a body over the limit", async () => {
    const big = new Request("https://gitinside.test/api/github/webhook", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
      body: "{}",
    });
    expect(await answer(big)).toEqual({ status: 413, body: { error: "BODY_TOO_LARGE" } });
  });

  it("answers ping", async () => {
    expect(await answer(delivery("ping", { zen: "Design for failure.", hook_id: 1 }))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
  });

  it("stores a new installation and links the stored repos it lists", async () => {
    await repo(1);
    await repo(2);
    const payload = installed("created", {
      repositories: [
        { id: 1, name: "r1", full_name: "octo-org/r1", private: true },
        { id: 3, name: "r3", full_name: "octo-org/r3", private: true },
      ],
    });
    expect(await answer(delivery("installation", payload))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await findInstallation(t.db, 41)).toMatchObject({
      accountId: 9001,
      accountLogin: "octo-org",
      accountType: "Organization",
      suspendedAt: null,
    });
    expect(await linked()).toEqual({ r1: true, r2: false });
    // A redelivery changes nothing.
    expect((await answer(delivery("installation", payload))).status).toBe(200);
    expect(await t.db.select().from(installations)).toHaveLength(1);
    expect(await linked()).toEqual({ r1: true, r2: false });
  });

  it("follows suspension, unsuspension, and a renamed account", async () => {
    await answer(delivery("installation", installed("created")));
    const suspendedAt = "2026-11-07T12:00:00Z";
    const suspended = {
      ...installed("suspend"),
      installation: { ...INSTALLATION, suspended_at: suspendedAt },
    };
    expect((await answer(delivery("installation", suspended))).status).toBe(200);
    expect((await findInstallation(t.db, 41))?.suspendedAt).toEqual(new Date(suspendedAt));

    const back = {
      ...installed("unsuspend"),
      installation: { ...INSTALLATION, account: { ...INSTALLATION.account, login: "renamed" } },
    };
    expect((await answer(delivery("installation", back))).status).toBe(200);
    expect(await findInstallation(t.db, 41)).toMatchObject({
      accountLogin: "renamed",
      suspendedAt: null,
    });
    expect(
      (await answer(delivery("installation", installed("new_permissions_accepted")))).status,
    ).toBe(200);
  });

  it("links repos added to an installation, storing it if it's new", async () => {
    await repo(5);
    await repo(6);
    const payload = installed("added", {
      repository_selection: "selected",
      repositories_added: [{ id: 6, name: "r6", full_name: "octo-org/r6", private: true }],
      repositories_removed: [],
    });
    expect(await answer(delivery("installation_repositories", payload))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await findInstallation(t.db, 41)).toBeDefined();
    expect(await linked()).toEqual({ r5: false, r6: true });
  });

  it("deletes an uninstalled installation's private data, rows and objects (M8.5a)", async () => {
    await installation41();
    const r1 = await repo(1);
    const r2 = await repo(2, "public");
    const r3 = await repo(3);
    await answer(
      delivery(
        "installation_repositories",
        installed("added", { repositories_added: [{ id: 1 }, { id: 2 }] }),
      ),
    );
    await stored(r1.id, `private/41/${r1.id}/${SHA}/0.1.0.json.gz`);
    await stored(r2.id, `private/41/${r2.id}/${SHA}/0.1.0.json.gz`);
    await stored(r2.id, `public/octo-org/r2/${SHA}/0.2.0.json.gz`, "0.2.0");
    await stored(r3.id, `private/42/${r3.id}/${SHA}/0.1.0.json.gz`);
    store.keys.add("private/41/stray/object"); // no row names it, still the installation's
    store.keys.add("private/410/x"); // another installation's, sharing the digits

    expect(await answer(delivery("installation", installed("deleted")))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await findInstallation(t.db, 41)).toBeUndefined();
    expect(await linked()).toEqual({ r2: false, r3: false });
    expect(await storedKeys()).toEqual([
      `private/42/${r3.id}/${SHA}/0.1.0.json.gz`,
      `public/octo-org/r2/${SHA}/0.2.0.json.gz`,
    ]);
    expect([...store.keys].sort()).toEqual([
      "private/410/x",
      `private/42/${r3.id}/${SHA}/0.1.0.json.gz`,
      `public/octo-org/r2/${SHA}/0.2.0.json.gz`,
    ]);
    // A redelivery finds nothing more to delete.
    expect((await answer(delivery("installation", installed("deleted")))).status).toBe(200);
    expect(store.keys.size).toBe(3);
  });

  it("deletes only the removed repos' private data, keeping the installation (M8.5a)", async () => {
    const id = await installation41();
    const r1 = await repo(1);
    const r2 = await repo(2);
    await answer(
      delivery(
        "installation_repositories",
        installed("added", { repositories_added: [{ id: 1 }, { id: 2 }] }),
      ),
    );
    await stored(r1.id, `private/41/${r1.id}/${SHA}/0.1.0.json.gz`);
    await stored(r2.id, `private/41/${r2.id}/${SHA}/0.1.0.json.gz`);
    const payload = installed("removed", {
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ id: 1, name: "r1", full_name: "octo-org/r1", private: true }],
    });
    expect(await answer(delivery("installation_repositories", payload))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect((await findInstallation(t.db, 41))?.id).toBe(id);
    expect(await linked()).toEqual({ r2: true });
    expect([...store.keys]).toEqual([`private/41/${r2.id}/${SHA}/0.1.0.json.gz`]);
    expect(await storedKeys()).toEqual([...store.keys]);
  });

  it("logs objects it couldn't delete and still answers 200: the rows are gone", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());
    await installation41();
    const r1 = await repo(1);
    await linkRepo(1);
    const key = `private/41/${r1.id}/${SHA}/0.1.0.json.gz`;
    await stored(r1.id, key);
    store.failDelete.add(key);
    expect(await answer(delivery("installation", installed("deleted")))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(await storedKeys()).toEqual([]);
    expect([...store.keys]).toEqual([key]); // retention's orphan sweep deletes it
    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])) as unknown)).toEqual([
      {
        event: "webhook_purge_failed",
        delivery: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        failed: 1,
      },
    ]);
  });

  it("refuses a deletion out of shape and deletes nothing", async () => {
    await installation41();
    await repo(1);
    await linkRepo(1);
    for (const [event, payload] of [
      ["installation", { ...installed("deleted"), installation: { id: "41" } }],
      ["installation", { action: "deleted" }],
      ["installation_repositories", installed("removed", { repositories_removed: "all" })],
      ["installation_repositories", installed("removed", { repositories_removed: [{ id: -1 }] })],
    ] as const) {
      expect(await answer(delivery(event, payload)), JSON.stringify(payload)).toEqual({
        status: 400,
        body: { error: "INVALID_PAYLOAD" },
      });
    }
    expect(await linked()).toEqual({ r1: true });
  });

  it("ignores other events and actions", async () => {
    for (const [event, payload] of [
      ["push", { ref: "refs/heads/main" }],
      ["pull_request", { action: "closed" }],
      ["installation", installed("some_new_action")],
      ["installation", installed("constructor")],
      ["installation_repositories", installed("toString")],
    ] as const) {
      expect(await answer(delivery(event, payload)), `${event}`).toEqual({
        status: 202,
        body: { status: "ignored" },
      });
    }
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("refuses a signed payload out of shape and writes nothing", async () => {
    const bad = [
      { ...installed("created"), action: 1 },
      { ...installed("created"), installation: undefined },
      { ...installed("created"), installation: { ...INSTALLATION, id: "41" } },
      { ...installed("created"), installation: { ...INSTALLATION, id: 0 } },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, login: "../x" } },
      },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, type: "Enterprise" } },
      },
      {
        ...installed("created"),
        installation: { ...INSTALLATION, account: { ...INSTALLATION.account, id: -1 } },
      },
      { ...installed("suspend"), installation: { ...INSTALLATION, suspended_at: "yesterday" } },
      { ...installed("suspend"), installation: { ...INSTALLATION, suspended_at: 5 } },
      installed("created", { repositories: "all" }),
      installed("created", { repositories: [{ id: 1 }, { name: "no-id" }] }),
    ];
    for (const payload of bad) {
      expect(await answer(delivery("installation", payload)), JSON.stringify(payload)).toEqual({
        status: 400,
        body: { error: "INVALID_PAYLOAD" },
      });
    }
    expect(await answer(delivery("Installation", installed("created")))).toEqual({
      status: 400,
      body: { error: "BAD_EVENT" },
    });
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("answers 500 on a database failure, logging the error's name only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => errors.mockRestore());
    const broken: WebhookDeps = {
      ...deps,
      db: {
        transaction: () => Promise.reject(new Error("postgres://user:secret@host")),
      } as unknown as WebhookDeps["db"],
    };
    expect(await answer(delivery("installation", installed("created")), broken)).toEqual({
      status: 500,
      body: { error: "INTERNAL" },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("secret");
  });
});

describe("handleWebhook: pull requests (M8.6d2)", () => {
  const BASE = "b".repeat(40);
  const HEAD = "1".repeat(40);
  const HEAD2 = "2".repeat(40);
  const AT = "2026-11-08T10:00:00Z";
  const LATER = "2026-11-08T10:05:00Z";

  function pr(
    action: string,
    { head = HEAD, base = BASE, at = AT, isPrivate = true } = {},
    extra: Record<string, unknown> = {},
  ) {
    return {
      action,
      number: 7,
      pull_request: {
        number: 7,
        state: "open",
        updated_at: at,
        base: { ref: "main", sha: base, repo: { id: 501 } },
        head: { ref: "feature", sha: head, repo: { id: 900 } }, // a fork's head
      },
      repository: {
        id: 501,
        name: "shop",
        full_name: "octo-org/shop",
        private: isPrivate,
        default_branch: "main",
        owner: { id: 9001, login: "octo-org" },
      },
      installation: { id: 41, node_id: "MDIz" },
      sender: { id: 7, login: "octo" },
      ...extra,
    };
  }

  const diffJob = (head = HEAD, base = BASE) =>
    ({
      kind: "diff",
      owner: "octo-org",
      repo: "shop",
      sha: head,
      baseSha: base,
      installationId: 41,
    }) as const;

  async function record() {
    const [repo] = await t.db.select().from(repos);
    return repo && findPullRequest(t.db, repo.id, 7);
  }

  const taskOperations = async () => (await computeUsageThisMonth(t.db)).taskOperations;
  /** Each delivery's logged outcome and detail, in order. */
  const details = () => logged().map((line) => `${String(line.outcome)}:${String(line.detail)}`);

  it("records the pull request and queues one diff task for its pair", async () => {
    await installation41();
    expect(await answer(delivery("pull_request", pr("opened")))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    const [repo] = await t.db.select().from(repos);
    expect(repo).toMatchObject({
      providerRepoId: 501,
      owner: "octo-org",
      name: "shop",
      visibility: "private",
      defaultBranch: "main",
    });
    expect(await linked()).toEqual({ shop: true });
    const jobId = jobIdFor(diffJob(), VERSION);
    const stored = await record();
    expect(stored).toMatchObject({
      baseSha: BASE,
      headSha: HEAD,
      headAt: new Date(AT),
      diffKey: null,
      diffJobId: jobId,
    });
    const queuedAt = stored?.diffQueuedAt ?? new Date(NaN);
    expect(queue.tasks).toEqual([{ job: diffJob(), taskId: taskIdFor(jobId, queuedAt) }]);
    expect(await taskOperations()).toBe(1);
  });

  it("a redelivery makes the same task name, which the queue refuses", async () => {
    await installation41();
    await answer(delivery("pull_request", pr("opened")));
    expect(await answer(delivery("pull_request", pr("opened")))).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect(queue.calls).toBe(2);
    expect(queue.tasks).toHaveLength(1);
    expect(await taskOperations()).toBe(2);
    expect(details()).toEqual(["ok:queued", "ok:already-queued"]);
  });

  it("a new head queues its own job; an older event afterwards queues nothing", async () => {
    await installation41();
    await answer(delivery("pull_request", pr("opened")));
    await answer(delivery("pull_request", pr("synchronize", { head: HEAD2, at: LATER })));
    expect(queue.tasks.map((task) => task.job)).toEqual([diffJob(), diffJob(HEAD2)]);
    expect(await record()).toMatchObject({
      headSha: HEAD2,
      diffJobId: jobIdFor(diffJob(HEAD2), VERSION),
    });
    // `opened` delivered late, or redelivered: the record stays on the newer head.
    expect((await answer(delivery("pull_request", pr("opened")))).status).toBe(200);
    expect(queue.calls).toBe(2);
    expect((await record())?.headSha).toBe(HEAD2);
    expect(details()).toEqual(["ok:queued", "ok:queued", "ok:stale"]);
  });

  it("a pair that already has its diff queues nothing, even reopened", async () => {
    await installation41();
    await answer(delivery("pull_request", pr("opened")));
    const [repo] = await t.db.select().from(repos);
    const repoId = repo?.id ?? "";
    expect(
      await recordPullRequestDiff(t.db, {
        repoId,
        number: 7,
        baseSha: BASE,
        headSha: HEAD,
        diffKey: "private/41/x/diffs/y/0.1.0.json.gz",
        brokenCount: 0,
      }),
    ).toBe(true);
    expect((await answer(delivery("pull_request", pr("reopened", { at: LATER })))).status).toBe(
      200,
    );
    expect(queue.calls).toBe(1);
    // A base-only change is a new pair: diffed again.
    const rebased = pr("synchronize", { base: "e".repeat(40), at: LATER });
    expect((await answer(delivery("pull_request", rebased))).status).toBe(200);
    expect(queue.tasks.map((task) => task.job.sha)).toEqual([HEAD, HEAD]);
    expect(queue.tasks[1]?.job).toEqual(diffJob(HEAD, "e".repeat(40)));
    expect(details()).toEqual(["ok:queued", "ok:diffed", "ok:queued"]);
  });

  it("stores a public repo as public, linked, and queues its diff through the installation", async () => {
    await installation41();
    await answer(delivery("pull_request", pr("opened", { isPrivate: false })));
    const [repo] = await t.db.select().from(repos);
    expect(repo?.visibility).toBe("public");
    expect(await linked()).toEqual({ shop: true });
    expect(queue.tasks.map((task) => task.job)).toEqual([diffJob()]);
  });

  it("ignores a pull request whose installation isn't stored or is suspended, writing nothing", async () => {
    expect(await answer(delivery("pull_request", pr("opened")))).toEqual({
      status: 202,
      body: { status: "ignored" },
    });
    await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 9001,
      accountLogin: "octo-org",
      accountType: "Organization",
      suspendedAt: new Date(AT),
    });
    expect(await answer(delivery("pull_request", pr("synchronize")))).toEqual({
      status: 202,
      body: { status: "ignored" },
    });
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(await t.db.select().from(pullRequests)).toEqual([]);
    expect(queue.calls).toBe(0);
    expect(details()).toEqual(["ignored:INSTALLATION_NOT_FOUND", "ignored:INSTALLATION_SUSPENDED"]);
  });

  it("ignores other actions, writing nothing", async () => {
    await installation41();
    for (const action of ["closed", "edited", "labeled", "ready_for_review", "constructor"]) {
      expect(await answer(delivery("pull_request", pr(action))), action).toEqual({
        status: 202,
        body: { status: "ignored" },
      });
    }
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(queue.calls).toBe(0);
  });

  it("answers 503 without a queue, writing nothing", async () => {
    await installation41();
    const noQueue: WebhookDeps = { db: t.db, store, secrets: [SECRET], analyzerVersion: VERSION };
    expect(await answer(delivery("pull_request", pr("opened")), noQueue)).toEqual({
      status: 503,
      body: { error: "QUEUE_UNAVAILABLE" },
    });
    expect(await t.db.select().from(repos)).toEqual([]);
    // Installation events don't need the queue.
    expect((await answer(delivery("installation", installed("created")), noQueue)).status).toBe(
      200,
    );
  });

  it("answers 503 when the task can't be created; a redelivery then creates it", async () => {
    await installation41();
    queue.fail = new WorkerUnavailableError("status 503");
    expect(await answer(delivery("pull_request", pr("opened")))).toEqual({
      status: 503,
      body: { error: "QUEUE_UNAVAILABLE" },
    });
    expect(await taskOperations()).toBe(1); // a failed create call is still an operation
    const jobId = jobIdFor(diffJob(), VERSION);
    const queuedAt = (await record())?.diffQueuedAt ?? new Date(NaN);
    queue.fail = undefined;
    expect((await answer(delivery("pull_request", pr("opened")))).status).toBe(200);
    expect(queue.tasks).toEqual([{ job: diffJob(), taskId: taskIdFor(jobId, queuedAt) }]);
  });

  it("refuses a pull request event out of shape and writes nothing", async () => {
    await installation41();
    const event = pr("opened");
    const bad = [
      { ...event, action: 5 },
      { ...event, installation: { id: "41" } },
      { ...event, repository: { ...event.repository, id: 0 } },
      { ...event, repository: { ...event.repository, name: ".." } },
      { ...event, repository: { ...event.repository, name: "a/b" } },
      { ...event, repository: { ...event.repository, owner: { login: "-x" } } },
      { ...event, repository: { ...event.repository, private: "yes" } },
      { ...event, repository: { ...event.repository, default_branch: "" } },
      { ...event, pull_request: { ...event.pull_request, number: 1.5 } },
      { ...event, pull_request: { ...event.pull_request, updated_at: "soon" } },
      { ...event, pull_request: { ...event.pull_request, updated_at: undefined } },
      { ...event, pull_request: { ...event.pull_request, base: { sha: "B".repeat(40) } } },
      { ...event, pull_request: { ...event.pull_request, head: { sha: "1".repeat(39) } } },
      { ...event, pull_request: undefined },
    ];
    for (const payload of bad) {
      expect(await answer(delivery("pull_request", payload)), JSON.stringify(payload)).toEqual({
        status: 400,
        body: { error: "INVALID_PAYLOAD" },
      });
    }
    expect(await t.db.select().from(repos)).toEqual([]);
    expect(queue.calls).toBe(0);
  });
});
