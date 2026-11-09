// @vitest-environment node
import {
  analyses,
  completeAnalysis,
  createSession,
  deletedInstallations,
  deleteInstallationData,
  installations,
  rateLimits,
  removedInstallationRepos,
  repos,
  sessions,
  startAnalysis,
  upsertInstallation,
  upsertRepo,
  upsertUser,
  users,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { jobIdFor } from "@gitinside/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_FOUND_MESSAGE, PRIVATE_HINT, type AnalyzeDeps } from "./analyze";
import { handleAnalyzeRequest } from "./analyzeRoute";
import type { AuthDeps } from "./authRoute";
import { userRateLimitKey } from "./clientIp";
import { fakeGitHub, type FakeGitHub } from "./github.testkit";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { fakeTaskQueue } from "./google.testkit";
import { failureView } from "./jobs";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";

/**
 * "Analyze" for a private repo (M8.4c2b, ADR-0235): `/api/analyze` asks a name the public lookup
 * doesn't find again with a signed-in user's own token, and queues a private repo they can see
 * through its account's installation; everyone else gets the public `REPO_NOT_FOUND` exactly.
 */

const SHA = "a".repeat(40);
const VERSION = "0.1.0";
const SECRET = "r".repeat(43);
const KEYS = sessionKeys("s".repeat(43));
const SECRET_ID = 9_001;
const OCTO: FakeAccount = { id: 7, login: "octo" };
const MALLORY: FakeAccount = { id: 8, login: "mallory" };
const JOB = {
  kind: "analyze",
  owner: "Acme",
  repo: "Secret",
  sha: SHA,
  installationId: 41,
} as const;
const JOB_ID = jobIdFor(JOB, VERSION);

let t: TestDb;
let gh: FakeGitHub;
let github: FakeOAuth;
let auth: AuthDeps;
let tasks: ReturnType<typeof fakeTaskQueue>;
let deps: AnalyzeDeps;
let acme: FakeInstallation;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  for (const table of [
    analyses,
    repos,
    installations,
    deletedInstallations,
    removedInstallationRepos,
    rateLimits,
    sessions,
    users,
  ]) {
    await t.db.delete(table);
  }
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // The server's token can't see the private repo: GitHub answers 404.
  gh = fakeGitHub([]);
  github = fakeOAuth();
  acme = {
    id: 41,
    account: { login: "acme", type: "Organization" },
    repos: [{ owner: "Acme", name: "Secret", private: true, id: SECRET_ID, sha: SHA }],
  };
  github.install(OCTO, [acme]);
  github.install(MALLORY, [
    {
      id: 52,
      account: { login: "mallory", type: "User" },
      repos: [{ owner: "mallory", name: "own", private: true, id: 9_002, sha: SHA }],
    },
  ]);
  auth = { db: t.db, client: { ...FAKE_CLIENT, fetch: github.fetch }, keys: KEYS };
  tasks = fakeTaskQueue(SECRET);
  deps = {
    db: t.db,
    queue: tasks.queue,
    github: { fetch: gh.fetch },
    analyzerVersion: VERSION,
    rateLimitSecret: SECRET,
    hourlyLimit: 5,
    signedInHourlyLimit: 30,
    signInAvailable: true,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A live session for `account`: its cookie, and its user's row ID. */
async function signIn(account: FakeAccount) {
  const issued = github.issue(account);
  const token = newToken();
  const tokenHash = hashToken(token);
  const userId = await upsertUser(t.db, { githubUserId: account.id, login: account.login });
  await createSession(t.db, {
    userId,
    tokenHash,
    githubTokens: sealTokens(KEYS, tokenHash, {
      accessToken: issued.accessToken,
      accessExpiresAt: Date.now() + EXPIRES_IN * 1000,
      refreshToken: issued.refreshToken,
      refreshExpiresAt: Date.now() + 1e10,
    }),
    lifetimeSeconds: 3600,
  });
  return { cookie: `${SESSION_COOKIE}=${token}`, userId, issued };
}

/** `POST /api/analyze` for `url` with `cookie`; the answer's status, headers, and body. */
async function analyze(url: string, cookie?: string) {
  const request = new Request("https://gitinside.test/api/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.7",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ url }),
  });
  const response = await handleAnalyzeRequest(request, deps, auth);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: (await response.json()) as Record<string, unknown>,
  };
}

const repoRows = () =>
  t.db
    .select({
      name: repos.name,
      visibility: repos.visibility,
      installationId: repos.installationId,
    })
    .from(repos);
const slots = async (userId: string) =>
  (await t.db.select().from(rateLimits)).find((r) => r.key === userRateLimitKey(userId))?.count ??
  0;

describe("Analyze for a private repo (M8.4c2b)", () => {
  it("queues a private repo the user sees through its account's installation", async () => {
    const octo = await signIn(OCTO);
    expect(await analyze("https://github.com/acme/secret", octo.cookie)).toMatchObject({
      status: 202,
      body: { status: "queued", jobId: JOB_ID, owner: "Acme", repo: "Secret", sha: SHA },
    });
    // The worker reads it through installation 41.
    expect(tasks.jobs()).toEqual([JOB]);
    // The installation stored from GitHub's answer (no webhook had arrived), the repo linked.
    const [installation] = await t.db.select().from(installations);
    expect(installation).toMatchObject({
      githubInstallationId: 41,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    expect(await repoRows()).toEqual([
      { name: "Secret", visibility: "private", installationId: installation?.id },
    ]);
    expect(await slots(octo.userId)).toBe(1);
    // Asked by name with the user's token, its code counted with it too.
    expect(github.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/repos/acme/secret",
      "/repos/Acme/Secret/commits/HEAD",
      "/user/installations",
      "/repos/Acme/Secret/languages",
    ]);
    // The server's token asked once, publicly, and was told 404.
    expect(gh.requests.map((r) => new URL(r.url).pathname)).toEqual(["/repos/acme/secret"]);

    // Asking again follows the same job: no second task, no second slot.
    expect(await analyze("acme/secret", octo.cookie)).toMatchObject({
      status: 202,
      body: { jobId: JOB_ID },
    });
    expect(tasks.google.tasks).toHaveLength(1);
    expect(await slots(octo.userId)).toBe(1);
  });

  it("opens a private repo's finished analysis without queueing", async () => {
    const octo = await signIn(OCTO);
    await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 1041,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    const { id: repoId } = await upsertRepo(t.db, {
      providerRepoId: SECRET_ID,
      owner: "Acme",
      name: "Secret",
      visibility: "private",
      defaultBranch: "main",
      githubInstallationId: 41,
    });
    const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: VERSION });
    await completeAnalysis(t.db, id, {
      snapshotKey: `private/41/${repoId}/${SHA}/${VERSION}.json.gz`,
      stats: { files: 1, nodes: 1, edges: 0, unresolved: 0 },
    });
    expect(await analyze("acme/secret", octo.cookie)).toEqual(
      expect.objectContaining({
        status: 200,
        body: { status: "done", owner: "Acme", repo: "Secret", sha: SHA },
      }),
    );
    expect(tasks.google.tasks).toEqual([]);
    expect(await slots(octo.userId)).toBe(0);
  });

  it("answers everyone else exactly as a name nobody can see, storing nothing", async () => {
    const signedOut = await analyze("acme/secret");
    expect(signedOut).toMatchObject({
      status: 404,
      body: { error: "REPO_NOT_FOUND", message: `${NOT_FOUND_MESSAGE} ${PRIVATE_HINT}` },
    });
    const mallory = await signIn(MALLORY);
    const octo = await signIn(OCTO);
    // The repo's account no longer lists the repo for OCTO (removed from the installation).
    const narrowed = { ...acme, repos: [] };
    const refused = [
      await analyze("acme/secret", `${SESSION_COOKIE}=${newToken()}`), // no live session
      await analyze("acme/secret", mallory.cookie), // can't see it
      await analyze("mallory/nothing", mallory.cookie), // nobody's repo
    ];
    github.install(OCTO, [narrowed]);
    refused.push(await analyze("acme/secret", octo.cookie));
    // A private repo GitHub shows the user without an installation on its account (can't
    // happen on GitHub, but must not queue anything).
    github.install(OCTO, [{ ...acme, account: { login: "other", type: "User" } }]);
    refused.push(await analyze("acme/secret", octo.cookie));
    for (const answer of refused) expect(answer).toEqual(signedOut);
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoRows()).toEqual([]);
    expect(await t.db.select().from(rateLimits)).toEqual([]);
  });

  it("answers a repo whose installation was uninstalled since GitHub answered as not found, storing nothing (M8.10e2a)", async () => {
    const signedOut = await analyze("acme/secret");
    const octo = await signIn(OCTO);
    // GitHub still lists installation 41 (the answer was read before the `deleted` delivery).
    await deleteInstallationData(t.db, 41, "all");
    expect(await analyze("acme/secret", octo.cookie)).toEqual(signedOut);
    expect(await t.db.select().from(installations)).toEqual([]);
    expect(await repoRows()).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
    expect(await t.db.select().from(rateLimits)).toEqual([]);
  });

  it("refuses a repo removed from the installation since GitHub answered, storing nothing (M8.10e2a)", async () => {
    const octo = await signIn(OCTO);
    await upsertInstallation(t.db, {
      githubInstallationId: 41,
      accountId: 1041,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    await deleteInstallationData(t.db, 41, [SECRET_ID]);
    expect(await analyze("acme/secret", octo.cookie)).toMatchObject({
      status: 403,
      body: { error: "REPO_NOT_INSTALLED", message: failureView("REPO_NOT_INSTALLED").message },
    });
    expect(await repoRows()).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
    expect(await slots(octo.userId)).toBe(0);
  });

  it("keeps the public lookup's answer for a repo the user's token sees as public", async () => {
    const octo = await signIn(OCTO);
    github.install(OCTO, [{ ...acme, repos: [{ ...acme.repos[0]!, private: false }] }]);
    expect(await analyze("acme/secret", octo.cookie)).toEqual(await analyze("acme/secret"));
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoRows()).toEqual([]);
  });

  it("says when the installation is suspended, storing nothing and giving the slot back", async () => {
    const octo = await signIn(OCTO);
    github.install(OCTO, [{ ...acme, suspendedAt: "2026-11-01T00:00:00Z" }]);
    expect(await analyze("acme/secret", octo.cookie)).toMatchObject({
      status: 403,
      body: {
        error: "INSTALLATION_SUSPENDED",
        message: failureView("INSTALLATION_SUSPENDED").message,
      },
    });
    expect(tasks.google.tasks).toEqual([]);
    expect(await repoRows()).toEqual([]);
    expect(await slots(octo.userId)).toBe(0);
  });

  it("says GitHub is unavailable when the user's lookup fails, and passes on the next try", async () => {
    const octo = await signIn(OCTO);
    github.failNext(new Response("bad gateway", { status: 502 }));
    expect(await analyze("acme/secret", octo.cookie)).toMatchObject({
      status: 503,
      body: { error: "GITHUB_UNAVAILABLE" },
    });
    expect(await repoRows()).toEqual([]);
    expect((await analyze("acme/secret", octo.cookie)).status).toBe(202);
  });

  it("answers a revoked authorization as GitHub unavailable, whatever the name", async () => {
    const octo = await signIn(OCTO);
    github.revoke(octo.issued.accessToken);
    // The same for a repo the user could see and one nobody has: it says nothing about either.
    const seen = await analyze("acme/secret", octo.cookie);
    expect(seen).toMatchObject({ status: 503, body: { error: "GITHUB_UNAVAILABLE" } });
    expect(await analyze("acme/nothing", octo.cookie)).toEqual(seen);
    expect(await repoRows()).toEqual([]);
  });

  it("ends the session when GitHub refuses the token on the installations read", async () => {
    const octo = await signIn(OCTO);
    auth.client = {
      ...auth.client,
      fetch: async (input, init) =>
        new URL(new Request(input, init).url).pathname === "/user/installations"
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : github.fetch(input, init),
    };
    expect(await analyze("acme/secret", octo.cookie)).toEqual(await analyze("acme/secret"));
    expect(await t.db.select().from(sessions)).toEqual([]);
    expect(tasks.google.tasks).toEqual([]);
  });

  it("leaves public repos to the server's token, signed in or not", async () => {
    gh = fakeGitHub([{ id: 4242, owner: "acme", name: "shop", sha: SHA }]);
    deps.github = { fetch: gh.fetch };
    const octo = await signIn(OCTO);
    expect(await analyze("acme/shop", octo.cookie)).toMatchObject({
      status: 202,
      body: { owner: "acme", repo: "shop" },
    });
    expect(tasks.jobs()).toEqual([{ kind: "analyze", owner: "acme", repo: "shop", sha: SHA }]);
    expect(github.requests).toEqual([]);
  });

  it("doesn't mention sign-in where it isn't set up", async () => {
    deps.signInAvailable = false;
    expect((await analyze("acme/secret")).body.message).toBe(NOT_FOUND_MESSAGE);
  });
});
