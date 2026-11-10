// @vitest-environment node
/**
 * The M8.8 security suite (docs/TESTING.md "Security tests", SECURITY.md T6–T8): the private
 * surfaces and signed entry points together, against two tenants at once, as an attacker
 * would meet them. Each route's own tests cover its rules one at a time; this file checks the
 * promises that span them:
 *
 * - **Cross-tenant isolation:** Acme's installation (41) and Globex's (52) each have a private
 *   repo named `Shop`, analyzed at the same commit, with a stored pull request diff, a code
 *   file, and a queued job. A member of one tenant reads all of their own on every surface and
 *   gets, for the other's, exactly what a name nobody analyzed gets, with no object read and
 *   no file asked of GitHub. The installation token route never mints across tenants, even
 *   though GitHub would (both repos are named `Shop`).
 * - **Revocation:** access removed on GitHub is refused on every surface once the 60 s check
 *   is old; a revoked authorization ends the session; an uninstall deletes the tenant's data
 *   at once and leaves the other's untouched.
 * - **Signatures:** the webhook and the token route refuse a request that's unsigned, signed
 *   with another secret or for another purpose, path, or body, or too old, before anything is
 *   read or written; the genuine request then succeeds.
 * - **Every API route is accounted for:** a new route fails {@link ROUTES} until it's listed
 *   with the test that covers its access rule.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  analyses,
  completeAnalysis,
  createSession,
  deletedInstallations,
  findSession,
  installations,
  pullRequests,
  queueAnalysis,
  recordPullRequestDiff,
  recordPullRequestHead,
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
import {
  derivedSecret,
  signRequest,
  TOKEN_REQUEST_PURPOSE,
  verifyRequest,
} from "@gitinside/worker/hmac";
import {
  privateDiffKey,
  privateSnapshotKey,
  type ListedObject,
  type ObjectBody,
  type ObjectStore,
} from "@gitinside/worker/storage";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AuthDeps } from "./authRoute";
import { handleDiffRequest } from "./diffRoute";
import { fakeApp, type FakeApp } from "./githubApp.testkit";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { handleWebhook, SIGNATURE_HEADER as WEBHOOK_SIGNATURE } from "./githubWebhook";
import { handleGraphRequest, type GraphRouteDeps } from "./graphRoute";
import {
  handleTokenRequest,
  TOKEN_ROUTE_PATH,
  type TokenRouteDeps,
} from "./installationTokenRoute";
import { handleJobEvents, handleJobRequest, jobRouteDeps } from "./jobRoute";
import { createHeadCache, viewRepo } from "./repoView";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";
import { handleSourceRequest } from "./sourceRoute";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const VERSION = "0.1.0";
const HEAD = "c".repeat(40);
const BASE = "e".repeat(40);
const NEXT = "f".repeat(40);
const KEYS = sessionKeys("s".repeat(43));
const WEBHOOK_SECRET = "w".repeat(43);
const ENQUEUE_SECRET = "q".repeat(43);
const TOKEN_KEY = derivedSecret(ENQUEUE_SECRET, TOKEN_REQUEST_PURPOSE);
const FILE = ["src", "billing.ts"];

/** One tenant: an installation of the app and its private repo, with everything stored for it. */
interface Tenant {
  installationId: number;
  accountId: number;
  owner: string;
  providerRepoId: number;
  member: FakeAccount;
  jobId: string;
  /** Set up by {@link store}. */
  repoId: string;
  keys: string[];
}

const ACME: Tenant = {
  installationId: 41,
  accountId: 9041,
  owner: "Acme",
  providerRepoId: 1,
  member: { id: 3_000_000_041, login: "octo" },
  jobId: `analyze-${"4".repeat(32)}`,
  repoId: "",
  keys: [],
};
const GLOBEX: Tenant = {
  installationId: 52,
  accountId: 9052,
  owner: "Globex",
  providerRepoId: 2,
  member: { id: 3_000_000_052, login: "hubot" },
  jobId: `analyze-${"5".repeat(32)}`,
  repoId: "",
  keys: [],
};
/** A name and job nobody analyzed: what every refusal must look like. */
const NOBODY = { owner: "Nobody", jobId: `analyze-${"0".repeat(32)}` };

/** What's stored in a tenant's objects and file: its name, so a leak is visible. */
const secretOf = (owner: string, what: string) => JSON.stringify({ owner, what });

let t: TestDb;
let github: FakeOAuth;
let app: FakeApp;
let auth: AuthDeps;
let objects: Map<string, string>;
let reads: string[];

/** The snapshot bucket in memory: reads recorded, listing by prefix, deletes. */
const bucket: Pick<ObjectStore, "get" | "list" | "delete"> = {
  async get(key): Promise<ObjectBody | undefined> {
    reads.push(key);
    const text = objects.get(key);
    if (text === undefined) return undefined;
    return { body: new Response(text).body!, contentType: "application/json" };
  },
  async *list(prefix = ""): AsyncIterable<ListedObject> {
    await Promise.resolve();
    for (const key of [...objects.keys()].sort()) {
      if (key.startsWith(prefix)) yield { key, size: 1, lastModified: new Date(0) };
    }
  },
  async delete(key) {
    await Promise.resolve();
    objects.delete(key);
  },
};

function fakeInstallation(tenant: Tenant): FakeInstallation {
  return {
    id: tenant.installationId,
    account: { id: tenant.accountId, login: tenant.owner, type: "Organization" },
    selection: "selected",
    repos: [
      {
        owner: tenant.owner,
        name: "Shop",
        private: true,
        id: tenant.providerRepoId,
        file: (path, ref) =>
          path === FILE.join("/") && ref === HEAD ? secretOf(tenant.owner, "file") : undefined,
      },
    ],
  };
}

/**
 * Store `tenant`'s installation and private repo: analyses of {@link BASE} and {@link HEAD},
 * pull request 7's diff of them, and a queued job for {@link NEXT}, with their objects.
 */
async function store(tenant: Tenant): Promise<void> {
  const { installationId } = tenant;
  await upsertInstallation(t.db, {
    githubInstallationId: installationId,
    accountId: tenant.accountId,
    accountLogin: tenant.owner,
    accountType: "Organization",
    suspendedAt: null,
  });
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: tenant.providerRepoId,
    owner: tenant.owner,
    name: "Shop",
    visibility: "private",
    defaultBranch: "main",
    githubInstallationId: installationId,
  });
  tenant.repoId = repoId;
  tenant.keys = [];
  for (const sha of [BASE, HEAD]) {
    const snapshotKey = privateSnapshotKey({
      installationId,
      repoId,
      sha,
      analyzerVersion: VERSION,
    });
    const { id } = await startAnalysis(t.db, { repoId, sha, analyzerVersion: VERSION });
    await completeAnalysis(t.db, id, {
      snapshotKey,
      stats: { files: 1, nodes: 0, edges: 0, unresolved: 0 },
    });
    objects.set(snapshotKey, secretOf(tenant.owner, `graph ${sha}`));
    tenant.keys.push(snapshotKey);
  }
  const diffKey = privateDiffKey({
    installationId,
    repoId,
    baseSha: BASE,
    headSha: HEAD,
    analyzerVersion: VERSION,
  });
  const pr = { repoId, number: 7, baseSha: "a".repeat(40), headSha: HEAD };
  await recordPullRequestHead(t.db, { ...pr, headAt: new Date(NOW - 60_000) });
  await recordPullRequestDiff(t.db, { ...pr, diffKey, brokenCount: 1 });
  objects.set(diffKey, secretOf(tenant.owner, "diff"));
  tenant.keys.push(diffKey);
  await queueAnalysis(
    t.db,
    { repoId, sha: NEXT, analyzerVersion: VERSION },
    { jobId: tenant.jobId },
  );
}

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(accessCache);
  await t.db.delete(sessions);
  await t.db.delete(users);
  await t.db.delete(pullRequests);
  await t.db.delete(analyses);
  await t.db.delete(repos);
  await t.db.delete(installations);
  await t.db.delete(deletedInstallations);
  await t.db.delete(removedInstallationRepos);
  objects = new Map();
  reads = [];
  github = fakeOAuth();
  github.install(ACME.member, [fakeInstallation(ACME)]);
  github.install(GLOBEX.member, [fakeInstallation(GLOBEX)]);
  app = fakeApp(
    [ACME, GLOBEX].map((tenant) => ({
      id: tenant.installationId,
      owner: tenant.owner,
      // The same name in both: GitHub would mint either by name, so only our check separates them.
      repos: ["Shop"],
    })),
    { now: () => NOW },
  );
  auth = { db: t.db, client: { ...FAKE_CLIENT, fetch: github.fetch }, keys: KEYS, now: () => NOW };
  await store(ACME);
  await store(GLOBEX);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onTestFinished(() => {
    log.mockRestore();
    error.mockRestore();
  });
});

/** A live session for `account`: its `Cookie` header and what's needed to end it. */
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
      accessExpiresAt: NOW + EXPIRES_IN * 1000,
      refreshToken: issued.refreshToken,
      refreshExpiresAt: NOW + 1e10,
    }),
    lifetimeSeconds: 3600,
  });
  return { cookie: `${SESSION_COOKIE}=${token}`, tokenHash, issued };
}

/** Everything a client can see of a response. */
async function seen(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

/** What a repo is looked up by on the surfaces: its owner's name and its job's ID. */
type Target = Pick<Tenant, "owner" | "jobId">;

/**
 * Every surface that serves a private repo's data, as `cookie` sees `target`'s: the graph, the
 * stored diff, a code file, the job and its events, and the permalink page.
 */
async function visit(target: Target, cookie: string | null) {
  const graphDeps: GraphRouteDeps = { db: t.db, store: bucket, auth };
  const jobs = jobRouteDeps(t.db, auth);
  const { owner } = target;
  const events = handleJobEvents(
    target.jobId,
    new AbortController().signal,
    jobs,
    { intervalMs: 1, lifetimeMs: 1 },
    cookie,
  );
  const page = await viewRepo(
    { owner, repo: "Shop", sha: HEAD },
    {
      db: t.db,
      queue: undefined,
      github: {},
      analyzerVersion: VERSION,
      heads: createHeadCache(),
      viewer: { cookie, auth },
    },
  );
  return {
    graph: await seen(
      await handleGraphRequest({ owner, repo: "Shop", sha: HEAD }, graphDeps, "identity", cookie),
    ),
    diff: await seen(
      await handleDiffRequest(
        { owner, repo: "Shop", base: BASE, head: HEAD },
        graphDeps,
        "identity",
        cookie,
      ),
    ),
    source: await seen(
      await handleSourceRequest({ owner, repo: "Shop", sha: HEAD, path: FILE }, auth, cookie),
    ),
    job: await seen(await handleJobRequest(target.jobId, jobs, cookie)),
    events: await seen(events),
    page,
  };
}

/** The answers for a repo nobody analyzed: every refusal must equal them, byte for byte. */
const missing = () => visit(NOBODY, null);

/** GitHub's file reads so far, by repo ID. */
const fileReads = () =>
  github.requests.filter((r) => r.url.includes("/contents/")).map((r) => new URL(r.url).pathname);

describe("cross-tenant isolation", () => {
  it("shows each tenant's member all of their own private data, and nothing of the other's", async () => {
    // The same commit in both tenants is two analyses with two keys.
    expect(ACME.keys[1]).not.toEqual(GLOBEX.keys[1]);
    for (const tenant of [ACME, GLOBEX]) {
      reads = [];
      const { cookie } = await signIn(tenant.member);
      const shown = await visit(tenant, cookie);
      expect(shown.graph.status).toBe(200);
      expect(shown.graph.body).toBe(secretOf(tenant.owner, `graph ${HEAD}`));
      expect(shown.diff.status).toBe(200);
      expect(shown.diff.body).toBe(secretOf(tenant.owner, "diff"));
      expect(shown.source.status).toBe(200);
      expect(shown.source.body).toBe(secretOf(tenant.owner, "file"));
      expect(shown.job.status).toBe(200);
      expect(JSON.parse(shown.job.body)).toMatchObject({ state: "queued" });
      expect(shown.events.body).toContain('"state":"queued"');
      expect(shown.page).toMatchObject({
        status: "ready",
        owner: tenant.owner,
        private: { providerRepoId: tenant.providerRepoId },
      });
      expect(reads.every((key) => key.startsWith(`private/${tenant.installationId}/`))).toBe(true);
    }
    expect(fileReads()).toEqual([
      `/repositories/1/contents/${FILE.join("/")}`,
      `/repositories/2/contents/${FILE.join("/")}`,
    ]);
  });

  it("answers a member of one tenant exactly as a missing repo for the other's, reading nothing", async () => {
    const expected = await missing();
    expect(expected.graph.status).toBe(404);
    expect(expected.page).toEqual({ status: "missing" });
    for (const [user, other] of [
      [ACME.member, GLOBEX],
      [GLOBEX.member, ACME],
    ] as const) {
      const { cookie } = await signIn(user);
      expect(await visit(other, cookie), `${user.login} → ${other.owner}`).toEqual(expected);
    }
    expect(reads).toEqual([]);
    expect(fileReads()).toEqual([]);
  });

  it("answers signed out, a dead cookie, and no sign-in configured exactly as a missing repo", async () => {
    const expected = await missing();
    for (const cookie of [null, `${SESSION_COOKIE}=${newToken()}`]) {
      expect(await visit(ACME, cookie)).toEqual(expected);
    }
    const { cookie } = await signIn(ACME.member);
    const unconfigured = {
      graph: await seen(
        await handleGraphRequest(
          { owner: "Acme", repo: "Shop", sha: HEAD },
          { db: t.db, store: bucket },
          "identity",
          cookie,
        ),
      ),
      source: await seen(
        await handleSourceRequest(
          { owner: "Acme", repo: "Shop", sha: HEAD, path: FILE },
          undefined,
          cookie,
        ),
      ),
      job: await seen(await handleJobRequest(ACME.jobId, jobRouteDeps(t.db), cookie)),
    };
    expect(unconfigured).toEqual({
      graph: expected.graph,
      source: expected.source,
      job: expected.job,
    });
    expect(reads).toEqual([]);
    expect(github.requests).toEqual([]);
  });

  it("never mints one tenant's job a token through the other's installation", async () => {
    const deps: TokenRouteDeps = {
      db: t.db,
      app: { appId: app.appId, privateKey: app.privateKey, fetch: app.fetch },
      keys: [TOKEN_KEY],
      now: () => NOW,
    };
    for (const [tenant, other] of [
      [ACME, GLOBEX],
      [GLOBEX, ACME],
    ] as const) {
      const response = await handleTokenRequest(
        tokenAsk({ jobId: tenant.jobId, installationId: other.installationId }),
        deps,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "REPO_NOT_INSTALLED" });
    }
    // Refused before GitHub, which can't tell the two `Shop`s apart by name.
    expect(app.requests).toEqual([]);

    const own = await handleTokenRequest(
      tokenAsk({ jobId: ACME.jobId, installationId: ACME.installationId }),
      deps,
    );
    expect(own.status).toBe(200);
    expect(app.issued).toEqual([
      { token: expect.any(String) as string, installationId: 41, repos: ["Shop"] },
    ]);
  });
});

describe("revocation", () => {
  it("refuses access removed on GitHub on every surface once the 60 s check is old", async () => {
    const { cookie } = await signIn(ACME.member);
    const allowed = await visit(ACME, cookie);
    expect(allowed.graph.status).toBe(200);
    github.install(ACME.member, []);

    // Within the minute the cached grant stands: the documented bound (SPEC §3). A code file
    // is read from GitHub with the user's own token, so GitHub refuses that one at once.
    const expected = await missing();
    expect(await visit(ACME, cookie)).toEqual({ ...allowed, source: expected.source });
    const [row] = await t.db.select().from(accessCache);
    await t.db.update(accessCache).set({
      checkedAt: new Date((row?.checkedAt.getTime() ?? 0) - ACCESS_TTL_SECONDS * 1000),
    });
    reads = [];
    expect(await visit(ACME, cookie)).toEqual(await missing());
    expect(reads).toEqual([]);
  });

  it("ends the session when the user revokes the app, refusing every surface", async () => {
    const { cookie, tokenHash, issued } = await signIn(ACME.member);
    github.revoke(issued.accessToken);
    expect(await visit(ACME, cookie)).toEqual(await missing());
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
    expect(reads).toEqual([]);
    expect(fileReads()).toEqual([]);
  });

  it("deletes an uninstalled tenant's data at once, leaving the other tenant's untouched", async () => {
    const acme = await signIn(ACME.member);
    const globex = await signIn(GLOBEX.member);
    expect((await visit(ACME, acme.cookie)).graph.status).toBe(200);
    const before = await visit(GLOBEX, globex.cookie);
    const globexRows = await rowsOf(GLOBEX);

    const response = await handleWebhook(uninstall(ACME), webhookDeps());
    expect(response.status).toBe(200);

    // Gone at once, the cached grant included: nothing left to show.
    expect(await visit(ACME, acme.cookie)).toEqual(await missing());
    expect([...objects.keys()].filter((key) => key.startsWith("private/41/"))).toEqual([]);
    expect(await rowsOf(ACME)).toEqual({ repos: 0, analyses: 0, pullRequests: 0 });
    // The other tenant: every row, object, and answer as before.
    expect(await rowsOf(GLOBEX)).toEqual(globexRows);
    expect([...objects.keys()].filter((key) => key.startsWith("private/52/")).sort()).toEqual(
      [...GLOBEX.keys].sort(),
    );
    // Only the queue position moved: it counts every queued job, whoever's (SPEC §3), and
    // Acme's was ahead.
    const after = await visit(GLOBEX, globex.cookie);
    expect(JSON.parse(before.job.body)).toMatchObject({ state: "queued", position: 1 });
    expect(JSON.parse(after.job.body)).toMatchObject({ state: "queued", position: 0 });
    const { job: _job, events: _events, ...rest } = after;
    const { job: _beforeJob, events: _beforeEvents, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
  });
});

/** How many rows `tenant`'s repo has in each table. */
async function rowsOf(tenant: Tenant) {
  const [repoRows, analysisRows, prRows] = await Promise.all([
    t.db.select().from(repos),
    t.db.select().from(analyses),
    t.db.select().from(pullRequests),
  ]);
  return {
    repos: repoRows.filter((r) => r.providerRepoId === tenant.providerRepoId).length,
    analyses: analysisRows.filter((a) => a.repoId === tenant.repoId).length,
    pullRequests: prRows.filter((p) => p.repoId === tenant.repoId).length,
  };
}

/** Everything stored, to show a refused request changed nothing. */
async function everything() {
  const [installationRows, repoRows, analysisRows, prRows] = await Promise.all([
    t.db.select().from(installations),
    t.db.select().from(repos),
    t.db.select().from(analyses),
    t.db.select().from(pullRequests),
  ]);
  return {
    installations: installationRows,
    repos: repoRows,
    analyses: analysisRows,
    pullRequests: prRows,
    objects: [...objects.keys()].sort(),
  };
}

const webhookDeps = () => ({
  db: t.db,
  store: bucket,
  secrets: [WEBHOOK_SECRET],
  analyzerVersion: VERSION,
});

const githubSignature = (body: string, secret = WEBHOOK_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** The `installation` `deleted` delivery for `tenant`, as GitHub sends it, signed by `sign`. */
function uninstall(
  tenant: Tenant,
  sign: (body: string) => string | null = (body) => githubSignature(body),
  edit: (body: string) => string = (body) => body,
): Request {
  const body = JSON.stringify({
    action: "deleted",
    installation: {
      id: tenant.installationId,
      account: { id: tenant.accountId, login: tenant.owner, type: "Organization" },
      repository_selection: "selected",
      suspended_at: null,
    },
    sender: { id: tenant.member.id, login: tenant.member.login },
  });
  const signature = sign(body);
  return new Request("https://gitinside.test/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "installation",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      ...(signature === null ? {} : { [WEBHOOK_SIGNATURE]: signature }),
    },
    body: edit(body),
  });
}

/** A token request for `ask`, signed as the worker signs it unless told otherwise. */
function tokenAsk(
  ask: { jobId: string; installationId: number },
  {
    key = TOKEN_KEY,
    at = NOW,
    path = TOKEN_ROUTE_PATH,
    signed = true,
    edit = (body: string) => body,
  }: {
    key?: string;
    at?: number;
    path?: string;
    signed?: boolean;
    edit?: (body: string) => string;
  } = {},
): Request {
  const body = JSON.stringify(ask);
  const headers = signed
    ? signRequest(key, { method: "POST", path, body: Buffer.from(body) }, at)
    : {};
  return new Request(`https://gitinside.test${TOKEN_ROUTE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: edit(body),
  });
}

describe("signatures", () => {
  it("refuses a forged webhook before anything is read or written, then takes GitHub's", async () => {
    const before = await everything();
    const forgeries: [string, Request][] = [
      ["unsigned", uninstall(GLOBEX, () => null)],
      ["signed with the job secret", uninstall(GLOBEX, (b) => githubSignature(b, ENQUEUE_SECRET))],
      ["signed with the token key", uninstall(GLOBEX, (b) => githubSignature(b, TOKEN_KEY))],
      [
        "another delivery's signature",
        uninstall(GLOBEX, () => githubSignature(JSON.stringify({ zen: "Design for failure." }))),
      ],
      [
        "the body changed after signing",
        uninstall(GLOBEX, undefined, (b) => b.replace("52", "41")),
      ],
      ["uppercase hex", uninstall(GLOBEX, (b) => githubSignature(b).toUpperCase())],
      ["SHA-1", uninstall(GLOBEX, (b) => githubSignature(b).replace("sha256=", "sha1="))],
    ];
    for (const [name, request] of forgeries) {
      const response = await handleWebhook(request, webhookDeps());
      expect(response.status, name).toBe(401);
      expect(await response.json(), name).toEqual({ error: "BAD_SIGNATURE" });
    }
    expect(await everything()).toEqual(before);

    expect((await handleWebhook(uninstall(GLOBEX), webhookDeps())).status).toBe(200);
    expect(await rowsOf(GLOBEX)).toEqual({ repos: 0, analyses: 0, pullRequests: 0 });
  });

  it("refuses a forged token request before anything is read or minted, then takes the worker's", async () => {
    const deps: TokenRouteDeps = {
      db: t.db,
      app: { appId: app.appId, privateKey: app.privateKey, fetch: app.fetch },
      keys: [TOKEN_KEY],
      now: () => NOW,
    };
    const ask = { jobId: GLOBEX.jobId, installationId: GLOBEX.installationId };
    const forgeries: [string, Request, string][] = [
      ["unsigned", tokenAsk(ask, { signed: false }), "MISSING_SIGNATURE"],
      ["signed with the job secret", tokenAsk(ask, { key: ENQUEUE_SECRET }), "BAD_SIGNATURE"],
      ["signed with the webhook secret", tokenAsk(ask, { key: WEBHOOK_SECRET }), "BAD_SIGNATURE"],
      ["signed for the worker's path", tokenAsk(ask, { path: "/run" }), "BAD_SIGNATURE"],
      ["signed 6 minutes ago", tokenAsk(ask, { at: NOW - 6 * 60_000 }), "STALE_TIMESTAMP"],
      [
        "the body changed after signing",
        tokenAsk(ask, { edit: (b) => b.replace(GLOBEX.jobId, ACME.jobId) }),
        "BAD_SIGNATURE",
      ],
    ];
    const before = await everything();
    for (const [name, request, error] of forgeries) {
      const response = await handleTokenRequest(request, deps);
      expect(response.status, name).toBe(401);
      expect(await response.json(), name).toEqual({ error });
    }
    expect(app.requests).toEqual([]);
    expect(await everything()).toEqual(before);

    expect((await handleTokenRequest(tokenAsk(ask), deps)).status).toBe(200);
    expect(app.issued).toHaveLength(1);
  });

  it("never lets the worker take a token request's signature as a job's", () => {
    // The worker's `/run` check (`run.ts`) is `verifyRequest` over the job secrets themselves.
    const parts = { method: "POST", path: "/run", body: Buffer.from("{}") };
    const asJob = signRequest(ENQUEUE_SECRET, parts, NOW);
    const asToken = signRequest(TOKEN_KEY, parts, NOW);
    const check = (headers: Record<string, string>) =>
      verifyRequest(
        [ENQUEUE_SECRET],
        parts,
        {
          timestamp: headers["x-gitinside-timestamp"],
          signature: headers["x-gitinside-signature"],
        },
        NOW,
      );
    expect(check(asJob)).toEqual({ ok: true });
    expect(check(asToken)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
});

/**
 * Every route under `app/api`, by what guards it and the test that proves it. A new route fails
 * the test below until it's listed here, so none ships without an access rule someone checked.
 */
const ROUTES: Readonly<Record<string, { guard: string; tests: string }>> = {
  "analyze/route.ts": {
    guard: "rate limits; private repos by the user's own token",
    tests: "privateAnalyze.test.ts",
  },
  "auth/github/route.ts": { guard: "starts sign-in (state + PKCE)", tests: "authRoute.test.ts" },
  "auth/github/callback/route.ts": {
    guard: "state, PKCE, install return",
    tests: "authRoute.test.ts",
  },
  "auth/signout/route.ts": { guard: "this site's Origin", tests: "authRoute.test.ts" },
  "badge/[owner]/[repo]/route.ts": { guard: "public repos only", tests: "imageRoute.test.ts" },
  "diagram/[owner]/[repo]/route.ts": { guard: "public repos only", tests: "imageRoute.test.ts" },
  "diagram/[owner]/[repo]/[sha]/route.ts": {
    guard: "public repos only",
    tests: "imageRoute.test.ts",
  },
  "diff/[owner]/[repo]/[base]/[head]/route.ts": {
    guard: "access check",
    tests: "security.test.ts",
  },
  "graph/[owner]/[repo]/[sha]/route.ts": { guard: "access check", tests: "security.test.ts" },
  "jobs/[id]/route.ts": { guard: "access check", tests: "security.test.ts" },
  "jobs/[id]/events/route.ts": { guard: "access check", tests: "security.test.ts" },
  "source/[owner]/[repo]/[sha]/[...path]/route.ts": {
    guard: "access check",
    tests: "security.test.ts",
  },
  "github/webhook/route.ts": { guard: "GitHub's signature", tests: "security.test.ts" },
  "worker/installation-token/route.ts": {
    guard: "the worker's signature",
    tests: "security.test.ts",
  },
};

describe("API routes", () => {
  it("lists every route with the test of its guard", () => {
    const lib = dirname(fileURLToPath(import.meta.url));
    const api = join(lib, "..", "app", "api");
    const found = readdirSync(api, { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.endsWith("/route.ts"))
      .sort();
    expect(found).toEqual(Object.keys(ROUTES).sort());
    const tests = new Set(readdirSync(lib));
    for (const [route, { tests: file }] of Object.entries(ROUTES)) {
      expect(tests.has(file), `${route} → ${file}`).toBe(true);
    }
  });
});
