// @vitest-environment node
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  createSession,
  findAccess,
  findSession,
  repos,
  sessions,
  upsertRepo,
  upsertUser,
  users,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, userAccessToken, type AuthDeps } from "./authRoute";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { checkRepoAccess } from "./repoAccess";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OCTO = { id: 3_000_000_007, login: "octo" };
const HUBOT = { id: 3_000_000_008, login: "hubot" };
const KEYS = sessionKeys("s".repeat(43));
const WEB_ID = 9_001;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await t.db.delete(accessCache);
  await t.db.delete(sessions);
  await t.db.delete(users);
  await t.db.delete(repos);
  vi.restoreAllMocks();
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const ACME = (repoIds: number[] = [WEB_ID]): FakeInstallation => ({
  id: 41,
  account: { login: "acme", type: "Organization" },
  selection: "selected",
  repos: repoIds.map((id) => ({ owner: "acme", name: `repo-${id}`, private: true, id })),
});

/** The stored private repo the checks are about. */
async function storedRepo(providerRepoId = WEB_ID) {
  const { id } = await upsertRepo(t.db, {
    providerRepoId,
    owner: "acme",
    name: `repo-${providerRepoId}`,
    visibility: "private",
    defaultBranch: "main",
  });
  return { id, providerRepoId };
}

/** `account` signed in, with a token ending `accessIn` ms after NOW. */
async function signedIn(
  github: FakeOAuth,
  account: FakeAccount = OCTO,
  options: { accessIn?: number } = {},
) {
  const issued = github.issue(account);
  const token = newToken();
  const tokenHash = hashToken(token);
  const userId = await upsertUser(t.db, { githubUserId: account.id, login: account.login });
  await createSession(t.db, {
    userId,
    tokenHash,
    githubTokens: sealTokens(KEYS, tokenHash, {
      accessToken: issued.accessToken,
      accessExpiresAt: NOW + (options.accessIn ?? EXPIRES_IN * 1000),
      refreshToken: issued.refreshToken,
      refreshExpiresAt: NOW + 1e10,
    }),
    lifetimeSeconds: 3600,
  });
  const deps: AuthDeps = {
    db: t.db,
    client: { ...FAKE_CLIENT, fetch: github.fetch },
    keys: KEYS,
    now: () => NOW,
  };
  const user = await readSession(`${SESSION_COOKIE}=${token}`, deps);
  if (user === undefined) throw new Error("not signed in");
  return { deps, user, tokenHash, issued };
}

const lookups = (github: FakeOAuth) =>
  github.requests.filter((r) => r.url.startsWith("https://api.github.com/repositories/")).length;

/** Make the (one) recorded answer `seconds` older. */
async function age(seconds: number) {
  const [row] = await t.db.select().from(accessCache);
  if (row === undefined) throw new Error("nothing recorded");
  await t.db
    .update(accessCache)
    .set({ checkedAt: new Date(row.checkedAt.getTime() - seconds * 1000) });
}

describe("checkRepoAccess", () => {
  it("allows a user GitHub shows the repo to, and asks GitHub once a minute at most", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    expect(github.requests.at(-1)).toEqual({
      method: "GET",
      url: `https://api.github.com/repositories/${WEB_ID}`,
    });
    expect(await findAccess(t.db, user.userId, repo.id)).toBe(true);

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    expect(lookups(github)).toBe(1);
  });

  it("refuses when GitHub doesn't show the repo to the user, and remembers the refusal", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME([9_002])]); // installed, but not on this repo
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(lookups(github)).toBe(1);
    expect(await findAccess(t.db, user.userId, repo.id)).toBe(false);
  });

  it("answers for each user on their own", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const octo = await signedIn(github, OCTO);
    const hubot = await signedIn(github, HUBOT);
    const repo = await storedRepo();

    expect(await checkRepoAccess(octo.user, repo, octo.deps)).toEqual({ allowed: true });
    expect(await checkRepoAccess(hubot.user, repo, hubot.deps)).toEqual({ allowed: false });
    expect(lookups(github)).toBe(2);
  });

  it("refuses access removed on GitHub within 60 seconds", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });

    github.install(OCTO, []); // removed from the installation, or the user from the org
    await age(ACCESS_TTL_SECONDS - 2);
    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    await age(2);
    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(lookups(github)).toBe(2);
  });

  it("refreshes a token about to end before asking", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user } = await signedIn(github, OCTO, { accessIn: 1_000 });
    const repo = await storedRepo();

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    expect(github.requests.map((r) => r.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      `https://api.github.com/repositories/${WEB_ID}`,
    ]);
  });

  it("ends the session when GitHub refuses the user's token, recording nothing", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user, tokenHash, issued } = await signedIn(github);
    const repo = await storedRepo();
    github.revoke(issued.accessToken);

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ ended: true });
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
    expect(await findAccess(t.db, user.userId, repo.id)).toBeUndefined();
  });

  it("refuses on a plain 403 (an organization's SAML or IP rules)", async () => {
    const github = fakeOAuth();
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    github.failNext(Response.json({ message: "Resource protected by SAML" }, { status: 403 }));

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(await findAccess(t.db, user.userId, repo.id)).toBe(false);
  });

  it("refuses a repo GitHub blocks (451), and remembers the refusal (F17)", async () => {
    const github = fakeOAuth();
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    github.failNext(Response.json({ message: "Repository access blocked" }, { status: 451 }));

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(await findAccess(t.db, user.userId, repo.id)).toBe(false);
    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: false });
    expect(lookups(github)).toBe(1);
  });

  it("dates GitHub's answer from when it was asked, so a slow one isn't trusted longer (F13)", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    // GitHub takes 30 s to answer, by the request's clock.
    let clock = NOW;
    const slow: AuthDeps = {
      ...deps,
      now: () => clock,
      client: {
        ...deps.client,
        fetch: async (input, init) => {
          const response = await github.fetch(input, init);
          clock += 30_000;
          return response;
        },
      },
    };

    expect(await checkRepoAccess(user, repo, slow)).toEqual({ allowed: true });
    const [row] = await t.db.select().from(accessCache);
    const ago = Date.now() - (row?.checkedAt.getTime() ?? 0);
    expect(ago).toBeGreaterThan(25_000);
    expect(ago).toBeLessThan(40_000);
  });

  it("refreshes the user's tokens once: a later call in the request uses the new token (F12)", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user, issued } = await signedIn(github, OCTO, { accessIn: 1_000 });
    const repo = await storedRepo();

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    // A second refresh would fail here (its refresh token is spent, or GitHub times out).
    github.failNext(new TypeError("fetch failed"));
    const second = await userAccessToken(user, deps);
    expect(second).toEqual({ token: user.tokens()?.accessToken });
    expect(second).not.toEqual({ token: issued.accessToken });
    const refreshes = github.requests.filter((r) => r.url.endsWith("/login/oauth/access_token"));
    expect(refreshes).toHaveLength(1);
  });

  const failures: [string, () => Response | Error][] = [
    [
      "a rate-limited 403",
      () =>
        Response.json(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
        ),
    ],
    [
      "a 403 asking to retry later",
      () =>
        Response.json({ message: "secondary" }, { status: 403, headers: { "retry-after": "60" } }),
    ],
    ["a 429", () => Response.json({ message: "slow down" }, { status: 429 })],
    ["a 500", () => new Response("oops", { status: 500 })],
    ["no answer", () => new TypeError("fetch failed")],
    ["an answer that isn't JSON", () => new Response("<html>", { status: 200 })],
    ["an answer for another repo", () => Response.json({ id: WEB_ID + 1 }, { status: 200 })],
    ["an answer without an ID", () => Response.json({ name: "repo" }, { status: 200 })],
  ];
  for (const [name, failure] of failures) {
    it(`is an error, not cached and never allowed, on ${name}`, async () => {
      const github = fakeOAuth();
      github.install(OCTO, [ACME()]);
      const { deps, user, issued } = await signedIn(github);
      const repo = await storedRepo();
      github.failNext(failure());

      expect(await checkRepoAccess(user, repo, deps)).toEqual({ error: true });
      expect(await findAccess(t.db, user.userId, repo.id)).toBeUndefined();
      expect(JSON.stringify(errors.mock.calls)).toContain("repo_access_failed");
      expect(JSON.stringify(errors.mock.calls)).not.toContain(issued.accessToken);
      // The next check asks again, and GitHub's real answer counts.
      expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    });
  }

  it("is an error when the cache can't be read, without asking GitHub", async () => {
    const github = fakeOAuth();
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    const broken = {
      ...deps,
      db: {
        select: () => {
          throw new Error("connection refused");
        },
      } as unknown as AuthDeps["db"],
    };

    expect(await checkRepoAccess(user, repo, broken)).toEqual({ error: true });
    expect(lookups(github)).toBe(0);
  });

  it("still answers when GitHub's answer can't be recorded", async () => {
    const github = fakeOAuth();
    github.install(OCTO, [ACME()]);
    const { deps, user } = await signedIn(github);
    const repo = await storedRepo();
    // Recording fails: the repo row is gone (a foreign key violation).
    await t.db.delete(repos);

    expect(await checkRepoAccess(user, repo, deps)).toEqual({ allowed: true });
    expect(JSON.stringify(errors.mock.calls)).toContain("repo_access_record_failed");
  });
});
