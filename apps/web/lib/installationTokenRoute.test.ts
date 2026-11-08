// @vitest-environment node
import {
  analyses,
  installations,
  queueAnalysis,
  queuePullRequestDiff,
  recordPullRequestCheckRun,
  recordPullRequestDiff,
  recordPullRequestHead,
  repos,
  startAnalysis,
  completeAnalysis,
  upsertInstallation,
  upsertRepo,
  type InstallationFacts,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { derivedSecret, signRequest, TOKEN_REQUEST_PURPOSE } from "@gitinside/worker/hmac";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FAKE_KEYS, fakeApp, TOKEN_LIFETIME_MS, type FakeApp } from "./githubApp.testkit";
import {
  handleTokenRequest,
  MAX_TOKEN_REQUEST_BYTES,
  TOKEN_ROUTE_PATH,
  type TokenRouteDeps,
} from "./installationTokenRoute";
import { tokenRouteDepsFromEnv } from "./serverDeps";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const SECRET = "e".repeat(43);
const PREVIOUS = "p".repeat(43);
const KEY = derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE);
const VERSION = "0.1.0";
const SHA = "a".repeat(40);
const JOB = `analyze-${"1".repeat(32)}`;
const ACME: InstallationFacts = {
  githubInstallationId: 41,
  accountId: 9001,
  accountLogin: "acme",
  accountType: "Organization",
  suspendedAt: null,
};
/** What GitInside's app asks of an installation (SPEC §3). */
const BOT_GRANTS = {
  contents: "read",
  metadata: "read",
  pull_requests: "write",
  checks: "write",
};

let t: TestDb;
let github: FakeApp;
let deps: TokenRouteDeps;
let logs: string[];
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
  github = fakeApp(
    [
      { id: 41, owner: "acme", repos: ["shop"], permissions: BOT_GRANTS },
      { id: 52, owner: "other", repos: ["shop"], permissions: BOT_GRANTS },
    ],
    { now: () => NOW },
  );
  deps = {
    db: t.db,
    app: { appId: github.appId, privateKey: github.privateKey, fetch: github.fetch },
    keys: [KEY],
    now: () => NOW,
  };
  logs = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  const error = vi.spyOn(console, "error").mockImplementation((line: string) => {
    logs.push(line);
  });
  onTestFinished(() => {
    log.mockRestore();
    error.mockRestore();
  });
});

/** Store acme/shop (linked to `installationId`, if given) and queue job {@link JOB} for it. */
async function queued(installationId?: number): Promise<{ repoId: string; analysisId: string }> {
  await upsertInstallation(t.db, ACME);
  await upsertInstallation(t.db, { ...ACME, githubInstallationId: 52, accountId: 9002 });
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 7,
    owner: "acme",
    name: "shop",
    visibility: "private",
    defaultBranch: "main",
    ...(installationId === undefined ? {} : { githubInstallationId: installationId }),
  });
  const row = await queueAnalysis(
    t.db,
    { repoId, sha: SHA, analyzerVersion: VERSION },
    { jobId: JOB },
  );
  return { repoId, analysisId: row.id };
}

function ask(
  body: unknown,
  {
    key = KEY,
    at = NOW,
    path = TOKEN_ROUTE_PATH,
    raw,
  }: { key?: string; at?: number; path?: string; raw?: string } = {},
): Request {
  const text = raw ?? JSON.stringify(body);
  const headers = signRequest(key, { method: "POST", path, body: Buffer.from(text) }, at);
  return new Request(`https://gitinside.test${TOKEN_ROUTE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

async function answer(request: Request, ...d: [TokenRouteDeps | undefined] | []) {
  const response = await handleTokenRequest(request, d.length === 0 ? deps : d[0]);
  return {
    status: response.status,
    cache: response.headers.get("cache-control"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

const forJob = { jobId: JOB, installationId: 41 };

describe("handleTokenRequest", () => {
  it("mints a one-repo read-only token for a queued job through its installation", async () => {
    await queued(41);
    const { status, cache, body } = await answer(ask(forJob));
    expect(status).toBe(200);
    expect(cache).toBe("no-store");
    const [issued] = github.issued;
    expect(body).toEqual({
      token: issued?.token,
      expiresAt: new Date(NOW + TOKEN_LIFETIME_MS).toISOString(),
    });
    expect(github.issued).toEqual([{ token: issued?.token, installationId: 41, repos: ["shop"] }]);
    expect(github.requests).toEqual([
      {
        method: "POST",
        path: "/app/installations/41/access_tokens",
        body: { repositories: ["shop"], permissions: { contents: "read", metadata: "read" } },
      },
    ]);
    // Logged by job ID and outcome, never with the token.
    expect(logs).toEqual([
      JSON.stringify({ event: "installation_token", jobId: JOB, outcome: "issued" }),
    ]);
    expect(logs.join("\n")).not.toContain(issued?.token);
  });

  it("mints for a running job too, but for no job that's done, failed, or unknown", async () => {
    const { repoId, analysisId } = await queued(41);
    await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION }, { jobId: JOB });
    expect((await answer(ask(forJob))).status).toBe(200);

    await completeAnalysis(t.db, analysisId, {
      snapshotKey: "private/41/x.json.gz",
      stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
    });
    expect(await answer(ask(forJob))).toMatchObject({
      status: 404,
      body: { error: "JOB_NOT_FOUND" },
    });
    const unknown = { jobId: `analyze-${"2".repeat(32)}`, installationId: 41 };
    expect(await answer(ask(unknown))).toMatchObject({
      status: 404,
      body: { error: "JOB_NOT_FOUND" },
    });
    expect(github.issued).toHaveLength(1);
  });

  it("mints for a live diff job through its pull request's repo, and not once it moved on", async () => {
    const { repoId } = await queued(41);
    const DIFF = `diff-${"3".repeat(32)}`;
    const pair = { repoId, number: 7, baseSha: SHA, headSha: "b".repeat(40) };
    await recordPullRequestHead(t.db, { ...pair, headAt: new Date(NOW) });
    await queuePullRequestDiff(t.db, { ...pair, jobId: DIFF });
    const forDiff = { jobId: DIFF, installationId: 41 };
    expect((await answer(ask(forDiff))).status).toBe(200);
    expect(github.issued).toEqual([
      { token: github.issued[0]?.token, installationId: 41, repos: ["shop"] },
    ]);
    // Only through the repo's own installation.
    expect(await answer(ask({ ...forDiff, installationId: 52 }))).toMatchObject({
      status: 403,
      body: { error: "REPO_NOT_INSTALLED" },
    });

    // A newer push: the job's pair is no longer the pull request's.
    await recordPullRequestHead(t.db, {
      ...pair,
      headSha: "c".repeat(40),
      headAt: new Date(NOW + 1000),
    });
    expect(await answer(ask(forDiff))).toMatchObject({
      status: 404,
      body: { error: "JOB_NOT_FOUND" },
    });
    expect(github.issued).toHaveLength(1);
  });

  describe("a diff job's post token (M8.6e1)", () => {
    const DIFF = `diff-${"3".repeat(32)}`;
    const forPost = { jobId: DIFF, installationId: 41, access: "post" };

    /** Pull request 7 of acme/shop with job {@link DIFF} queued; its pair. */
    async function diffQueued(installationId = 41) {
      const { repoId } = await queued(installationId);
      const pair = { repoId, number: 7, baseSha: SHA, headSha: "b".repeat(40) };
      await recordPullRequestHead(t.db, { ...pair, headAt: new Date(NOW) });
      await queuePullRequestDiff(t.db, { ...pair, jobId: DIFF });
      return pair;
    }
    const diffed = (pair: Awaited<ReturnType<typeof diffQueued>>) =>
      recordPullRequestDiff(t.db, { ...pair, diffKey: "d.json.gz", brokenCount: 1 });

    it("mints pull requests and checks written, no code, once the diff is recorded", async () => {
      await diffed(await diffQueued());
      const { status, cache, body } = await answer(ask(forPost));
      expect(status).toBe(200);
      expect(cache).toBe("no-store");
      expect(body.token).toBe(github.issued[0]?.token);
      expect(github.requests).toEqual([
        {
          method: "POST",
          path: "/app/installations/41/access_tokens",
          body: {
            repositories: ["shop"],
            permissions: { pull_requests: "write", checks: "write", metadata: "read" },
          },
        },
      ]);
      expect(logs).toEqual([
        JSON.stringify({
          event: "installation_token",
          jobId: DIFF,
          access: "post",
          outcome: "issued",
        }),
      ]);
      // The read token's step is over: a diffed job reads nothing more.
      expect(await answer(ask({ jobId: DIFF, installationId: 41 }))).toMatchObject({
        status: 404,
        body: { error: "JOB_NOT_FOUND" },
      });
    });

    it("mints no post token before the diff is recorded or once the Check Run is", async () => {
      const pair = await diffQueued();
      expect(await answer(ask(forPost))).toMatchObject({
        status: 404,
        body: { error: "JOB_NOT_FOUND" },
      });
      // The read token, explicitly asked for, is the queued job's.
      expect((await answer(ask({ ...forPost, access: "read" }))).body).toHaveProperty("token");

      await diffed(pair);
      await recordPullRequestCheckRun(t.db, { ...pair, checkRunId: 77 });
      expect(await answer(ask(forPost))).toMatchObject({
        status: 404,
        body: { error: "JOB_NOT_FOUND" },
      });
      expect(github.issued).toHaveLength(1); // the read token only
    });

    it("checks the installation as the read token does", async () => {
      await diffed(await diffQueued());
      expect(await answer(ask({ ...forPost, installationId: 52 }))).toMatchObject({
        status: 403,
        body: { error: "REPO_NOT_INSTALLED" },
      });
      await upsertInstallation(t.db, { ...ACME, suspendedAt: new Date(NOW - 1000) });
      expect(await answer(ask(forPost))).toMatchObject({
        status: 403,
        body: { error: "INSTALLATION_SUSPENDED" },
      });
      await t.db.update(repos).set({ installationId: null });
      expect(await answer(ask(forPost))).toMatchObject({
        status: 403,
        body: { error: "INSTALLATION_NOT_FOUND" },
      });
      expect(github.requests).toEqual([]);
    });

    it("answers an installation that hasn't granted the bot's writes as not installed", async () => {
      github = fakeApp([{ id: 41, owner: "acme", repos: ["shop"] }], { now: () => NOW });
      deps = { ...deps, app: { ...deps.app, fetch: github.fetch } };
      await diffed(await diffQueued());
      expect(await answer(ask(forPost))).toMatchObject({
        status: 403,
        body: { error: "REPO_NOT_INSTALLED" },
      });
    });

    it.each([
      ["an analysis job", { jobId: JOB, installationId: 41, access: "post" }],
      ["another access", { ...forPost, access: "write" }],
      ["a non-string access", { ...forPost, access: 1 }],
    ])("refuses a post asked for %s", async (_, body) => {
      await diffed(await diffQueued());
      expect(await answer(ask(body))).toMatchObject({
        status: 400,
        body: { error: "INVALID_REQUEST" },
      });
      expect(github.requests).toEqual([]);
    });
  });

  it("refuses an installation the repo isn't linked to, asking GitHub nothing", async () => {
    await queued(41);
    // Installation 52 would cover a repo named shop; the row's link decides.
    expect(await answer(ask({ jobId: JOB, installationId: 52 }))).toEqual({
      status: 403,
      cache: "no-store",
      body: { error: "REPO_NOT_INSTALLED" },
    });
    await t.db.update(repos).set({ installationId: null });
    expect(await answer(ask(forJob))).toMatchObject({
      status: 403,
      body: { error: "INSTALLATION_NOT_FOUND" },
    });
    expect(github.requests).toEqual([]);
  });

  it("refuses a stored suspension without asking GitHub", async () => {
    await queued(41);
    await upsertInstallation(t.db, { ...ACME, suspendedAt: new Date(NOW - 1000) });
    expect(await answer(ask(forJob))).toMatchObject({
      status: 403,
      body: { error: "INSTALLATION_SUSPENDED" },
    });
    expect(github.requests).toEqual([]);
    expect(logs).toEqual([
      JSON.stringify({
        event: "installation_token",
        jobId: JOB,
        outcome: "INSTALLATION_SUSPENDED",
      }),
    ]);
  });

  it.each([
    [Response.json({}, { status: 401 }), 503, "APP_AUTH_FAILED"],
    [Response.json({}, { status: 404 }), 403, "INSTALLATION_NOT_FOUND"],
    [Response.json({}, { status: 422 }), 403, "REPO_NOT_INSTALLED"],
    [Response.json({}, { status: 500 }), 502, "GITHUB_UNAVAILABLE"],
    [new Error("connection refused"), 502, "GITHUB_UNAVAILABLE"],
  ] as const)("answers GitHub's refusals by code (%#)", async (failure, status, error) => {
    await queued(41);
    github.failNext(failure);
    expect(await answer(ask(forJob))).toEqual({ status, cache: "no-store", body: { error } });
  });

  it("answers a suspension GitHub knows of before the webhook arrived", async () => {
    await queued(41);
    github.failNext(Response.json({}, { status: 403 }));
    github.failNext(Response.json({ id: 41, suspended_at: "2026-11-07T11:00:00Z" }));
    expect(await answer(ask(forJob))).toMatchObject({
      status: 403,
      body: { error: "INSTALLATION_SUSPENDED" },
    });
  });

  it("refuses a body naming anything else, such as a repo: that comes from the row", async () => {
    await queued(41);
    const asked = { ...forJob, owner: "other", repo: "secret" };
    expect(await answer(ask(asked))).toMatchObject({
      status: 400,
      body: { error: "INVALID_REQUEST" },
    });
    expect(github.requests).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no installation", JSON.stringify({ jobId: JOB })],
    ["a malformed job ID", JSON.stringify({ jobId: "analyze-1", installationId: 41 })],
    [
      "another kind's job ID",
      JSON.stringify({ jobId: `push-${"1".repeat(32)}`, installationId: 41 }),
    ],
    ["a string installation", JSON.stringify({ jobId: JOB, installationId: "41" })],
    ["installation 0", JSON.stringify({ jobId: JOB, installationId: 0 })],
    ["a fractional installation", JSON.stringify({ jobId: JOB, installationId: 41.5 })],
  ])("refuses a signed body that's %s", async (_, raw) => {
    await queued(41);
    expect(await answer(ask(undefined, { raw }))).toMatchObject({
      status: 400,
      body: { error: "INVALID_REQUEST" },
    });
  });
});

describe("the worker's signature", () => {
  it("is checked before the body is read as JSON or the database is asked", async () => {
    await queued(41);
    const unsigned = new Request(`https://gitinside.test${TOKEN_ROUTE_PATH}`, {
      method: "POST",
      body: "{",
    });
    expect(await answer(unsigned)).toEqual({
      status: 401,
      cache: "no-store",
      body: { error: "MISSING_SIGNATURE" },
    });
    expect(github.requests).toEqual([]);
  });

  it("must use the derived key: the secret itself, as the enqueue signature does, fails", async () => {
    await queued(41);
    expect(await answer(ask(forJob, { key: SECRET }))).toMatchObject({
      status: 401,
      body: { error: "BAD_SIGNATURE" },
    });
    const other = derivedSecret(SECRET, "gitinside/v1/other");
    expect(await answer(ask(forJob, { key: other }))).toMatchObject({ status: 401 });
  });

  it("binds this path and is at most 5 minutes old", async () => {
    await queued(41);
    expect(await answer(ask(forJob, { path: "/run" }))).toMatchObject({
      status: 401,
      body: { error: "BAD_SIGNATURE" },
    });
    expect(await answer(ask(forJob, { at: NOW - 301_000 }))).toMatchObject({
      status: 401,
      body: { error: "STALE_TIMESTAMP" },
    });
    expect((await answer(ask(forJob, { at: NOW - 299_000 }))).status).toBe(200);
  });

  it("is accepted under the previous secret's key during a rotation", async () => {
    await queued(41);
    const previous = derivedSecret(PREVIOUS, TOKEN_REQUEST_PURPOSE);
    expect((await answer(ask(forJob, { key: previous }))).status).toBe(401);
    const rotating = { ...deps, keys: [KEY, previous] };
    expect((await answer(ask(forJob, { key: previous }), rotating)).status).toBe(200);
  });

  it("refuses a body over the cap unread, and answers 503 when not configured", async () => {
    const big = "x".repeat(MAX_TOKEN_REQUEST_BYTES + 1);
    expect(await answer(ask(undefined, { raw: big }))).toMatchObject({
      status: 413,
      body: { error: "BODY_TOO_LARGE" },
    });
    expect(await answer(ask(forJob), undefined)).toEqual({
      status: 503,
      cache: "no-store",
      body: { error: "UNAVAILABLE" },
    });
  });
});

describe("tokenRouteDepsFromEnv", () => {
  const PEM = FAKE_KEYS.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const env = {
    DATABASE_URL: "postgres://u:p@127.0.0.1:5/db",
    GITHUB_APP_ID: "424242",
    GITHUB_APP_PRIVATE_KEY: PEM,
    ENQUEUE_HMAC_SECRET: SECRET,
  };

  it("derives the current secret's key, then the previous one's", () => {
    expect(tokenRouteDepsFromEnv(env)?.keys).toEqual([KEY]);
    expect(tokenRouteDepsFromEnv({ ...env, ENQUEUE_HMAC_SECRET_PREVIOUS: PREVIOUS })?.keys).toEqual(
      [KEY, derivedSecret(PREVIOUS, TOKEN_REQUEST_PURPOSE)],
    );
  });

  it("is undefined without the database, the app, or a long enough secret", () => {
    for (const name of Object.keys(env)) {
      expect(tokenRouteDepsFromEnv({ ...env, [name]: "" }), name).toBeUndefined();
    }
    expect(tokenRouteDepsFromEnv({ ...env, ENQUEUE_HMAC_SECRET: "short" })).toBeUndefined();
    expect(
      tokenRouteDepsFromEnv({ ...env, ENQUEUE_HMAC_SECRET_PREVIOUS: "short" }),
    ).toBeUndefined();
  });
});
