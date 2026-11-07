// @vitest-environment node
import { createSession, findSession, sessions, upsertUser, users } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, REFRESH_MARGIN_MS, type AuthDeps } from "./authRoute";
import { installationSettingsUrl, installUrl, loadDashboard } from "./dashboard";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import {
  hashToken,
  newToken,
  openTokens,
  SESSION_COOKIE,
  sealTokens,
  sessionKeys,
  type GitHubTokens,
} from "./session";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OCTO = { id: 3_000_000_007, login: "octo" };
const KEYS = sessionKeys("s".repeat(43));

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.db.delete(sessions);
  await t.db.delete(users);
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const repos = (owner: string, count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    owner,
    name: `repo-${String(from + i).padStart(3, "0")}`,
  }));

const ACME: FakeInstallation = {
  id: 41,
  account: { login: "acme", type: "Organization" },
  selection: "selected",
  repos: [
    { owner: "acme", name: "web", private: true },
    { owner: "acme", name: "Api" },
  ],
};
const OWN: FakeInstallation = {
  id: 7,
  account: { login: "octo", type: "User" },
  repos: [{ owner: "octo", name: "dotfiles" }],
};

/**
 * A signed-in `octo` whose stored tokens are `issued` with the given expiries (relative to
 * NOW), and the deps the dashboard reads with.
 */
async function signedIn(
  options: {
    github?: FakeOAuth;
    accessIn?: number | null;
    refreshIn?: number | null;
    keys?: typeof KEYS;
    slug?: string;
  } = {},
) {
  const github = options.github ?? fakeOAuth();
  const issued = github.issue(OCTO);
  const accessIn = options.accessIn === undefined ? EXPIRES_IN * 1000 : options.accessIn;
  const refreshIn = options.refreshIn === undefined ? 1e10 : options.refreshIn;
  const tokens: GitHubTokens = {
    accessToken: issued.accessToken,
    accessExpiresAt: accessIn === null ? null : NOW + accessIn,
    refreshToken: issued.refreshToken,
    refreshExpiresAt: refreshIn === null ? null : NOW + refreshIn,
  };
  const token = newToken();
  const tokenHash = hashToken(token);
  const userId = await upsertUser(t.db, { githubUserId: OCTO.id, login: OCTO.login });
  await createSession(t.db, {
    userId,
    tokenHash,
    githubTokens: sealTokens(options.keys ?? KEYS, tokenHash, tokens),
    lifetimeSeconds: 3600,
  });
  const deps: AuthDeps = {
    db: t.db,
    client: { ...FAKE_CLIENT, fetch: github.fetch },
    keys: KEYS,
    now: () => NOW,
    ...(options.slug !== undefined && { appSlug: options.slug }),
  };
  const cookie = `${SESSION_COOKIE}=${token}`;
  const user = await readSession(cookie, deps);
  if (user === undefined) throw new Error("not signed in");
  return { github, deps, user, tokenHash, issued, cookie };
}

const refreshes = (github: FakeOAuth) =>
  github.requests.filter((r) => r.url === "https://github.com/login/oauth/access_token").length;

describe("loadDashboard", () => {
  it("lists the user's installations and their repos, sorted, with the install link", async () => {
    const { github, deps, user } = await signedIn({ slug: "gitinside" });
    github.install(OCTO, [OWN, ACME]);
    expect(await loadDashboard(user, deps)).toEqual({
      kind: "ready",
      total: 2,
      installUrl: "https://github.com/apps/gitinside/installations/new",
      installations: [
        {
          id: 41,
          account: "acme",
          accountType: "Organization",
          selection: "selected",
          repos: [
            { owner: "acme", name: "Api", private: false },
            { owner: "acme", name: "web", private: true },
          ],
          totalRepos: 2,
        },
        {
          id: 7,
          account: "octo",
          accountType: "User",
          selection: "all",
          repos: [{ owner: "octo", name: "dotfiles", private: false }],
          totalRepos: 1,
        },
      ],
    });
    // The user's own token, not the app's: GitHub filters to what this user can see.
    expect(github.requests.map((r) => r.url)).toEqual([
      "https://api.github.com/user/installations?per_page=100",
      "https://api.github.com/user/installations/7/repositories?per_page=100&page=1",
      "https://api.github.com/user/installations/41/repositories?per_page=100&page=1",
    ]);
  });

  it("is empty with no installations, and has no install link without a slug", async () => {
    const { deps, user } = await signedIn();
    expect(await loadDashboard(user, deps)).toEqual({ kind: "ready", installations: [], total: 0 });
  });

  it("reads up to three pages of repos and counts the rest", async () => {
    const { github, deps, user } = await signedIn();
    github.install(OCTO, [
      { ...OWN, repos: repos("octo", 150) },
      { ...ACME, repos: repos("acme", 345) },
    ]);
    const view = await loadDashboard(user, deps);
    if (view.kind !== "ready") throw new Error(view.kind);
    const [acme, octo] = view.installations;
    expect(octo?.repos).toHaveLength(150);
    expect(octo?.totalRepos).toBe(150);
    expect(acme?.repos).toHaveLength(300);
    expect(acme?.repos.at(-1)?.name).toBe("repo-299");
    expect(acme?.totalRepos).toBe(345);
    expect(github.requests.filter((r) => r.url.includes("/41/"))).toHaveLength(3);
    expect(github.requests.filter((r) => r.url.includes("/7/"))).toHaveLength(2);
  });

  it("reads many installations' repos a few at a time", async () => {
    const { github, deps, user } = await signedIn();
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      account: { login: `org-${String(i).padStart(2, "0")}`, type: "Organization" as const },
      repos: repos(`org-${String(i).padStart(2, "0")}`, 1),
    }));
    github.install(OCTO, many);
    let inFlight = 0;
    let peak = 0;
    const counting: typeof fetch = async (input, init) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await github.fetch(input, init);
      } finally {
        inFlight--;
      }
    };
    const view = await loadDashboard(user, {
      ...deps,
      client: { ...deps.client, fetch: counting },
    });
    if (view.kind !== "ready") throw new Error(view.kind);
    expect(view.installations.map((i) => i.account)).toEqual(many.map((i) => i.account.login));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("refreshes an access token about to end, stores the new pair, and uses it", async () => {
    const { github, deps, user, tokenHash, issued, cookie } = await signedIn({
      accessIn: REFRESH_MARGIN_MS - 1,
    });
    github.install(OCTO, [OWN]);
    expect((await loadDashboard(user, deps)).kind).toBe("ready");
    expect(refreshes(github)).toBe(1);

    const stored = await findSession(t.db, tokenHash);
    const tokens = openTokens(KEYS, tokenHash, stored?.githubTokens ?? "");
    expect(tokens?.accessToken).not.toBe(issued.accessToken);
    expect(tokens?.refreshToken).not.toBe(issued.refreshToken);
    expect(tokens?.accessExpiresAt).toBe(NOW + EXPIRES_IN * 1000);

    // The next visit reads the stored pair and doesn't refresh again.
    const again = await readSession(cookie, deps);
    if (again === undefined) throw new Error("signed out");
    expect((await loadDashboard(again, deps)).kind).toBe("ready");
    expect(refreshes(github)).toBe(1);
  });

  it("keeps a token with time left, and one that doesn't expire", async () => {
    const left = await signedIn({ accessIn: REFRESH_MARGIN_MS + 1 });
    expect((await loadDashboard(left.user, left.deps)).kind).toBe("ready");
    expect(refreshes(left.github)).toBe(0);
    await t.db.delete(sessions);
    const forever = await signedIn({ accessIn: null, refreshIn: null });
    expect((await loadDashboard(forever.user, forever.deps)).kind).toBe("ready");
    expect(refreshes(forever.github)).toBe(0);
  });

  it("lets two requests refresh at once: the loser reads the winner's tokens", async () => {
    const { github, deps, user, tokenHash } = await signedIn({ accessIn: 0 });
    github.install(OCTO, [OWN]);
    const views = await Promise.all([loadDashboard(user, deps), loadDashboard(user, deps)]);
    expect(views.map((v) => v.kind)).toEqual(["ready", "ready"]);
    expect(refreshes(github)).toBe(2); // the second was refused: refresh tokens are single use
    expect(await findSession(t.db, tokenHash)).toBeDefined();
  });

  it("waits for the winner of a refresh to store its tokens before giving up", async () => {
    const github = fakeOAuth();
    const { deps, user, tokenHash } = await signedIn({ github, accessIn: 0 });
    github.install(OCTO, [OWN]);
    // The first refresh is answered last: the second is refused while the first is in flight.
    let calls = 0;
    const slowFirst: typeof fetch = async (input, init) => {
      const response = await github.fetch(input, init);
      if (String(input).endsWith("/access_token") && ++calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return response;
    };
    const slow = { ...deps, client: { ...deps.client, fetch: slowFirst } };
    const views = await Promise.all([loadDashboard(user, slow), loadDashboard(user, slow)]);
    expect(views.map((v) => v.kind)).toEqual(["ready", "ready"]);
    expect(await findSession(t.db, tokenHash)).toBeDefined();
  });

  it("signs out when GitHub refuses the refresh token", async () => {
    const { github, deps, user, tokenHash, issued } = await signedIn({ accessIn: 0 });
    github.revoke(issued.refreshToken);
    expect(await loadDashboard(user, deps)).toEqual({ kind: "ended" });
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
  });

  it("signs out without asking GitHub when the refresh token has ended", async () => {
    const { github, deps, user, tokenHash } = await signedIn({ accessIn: 0, refreshIn: 0 });
    expect(await loadDashboard(user, deps)).toEqual({ kind: "ended" });
    expect(github.requests).toEqual([]);
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
  });

  it("signs out when the stored tokens don't open (a rotated SESSION_SECRET)", async () => {
    const { github, deps, user, tokenHash } = await signedIn({ keys: sessionKeys("r".repeat(43)) });
    expect(await loadDashboard(user, deps)).toEqual({ kind: "ended" });
    expect(github.requests).toEqual([]);
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
  });

  it("signs out when GitHub refuses a live access token (authorization revoked)", async () => {
    const { github, deps, user, tokenHash, issued } = await signedIn();
    github.revoke(issued.accessToken);
    expect(await loadDashboard(user, deps)).toEqual({ kind: "ended" });
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
  });

  it("says GitHub can't be read, still signed in, when GitHub fails or answers out of shape", async () => {
    const { github, deps, user, tokenHash } = await signedIn({ slug: "gitinside" });
    const error = {
      kind: "error",
      installUrl: "https://github.com/apps/gitinside/installations/new",
    };
    github.failNext(Response.json({ message: "Server Error" }, { status: 502 }));
    expect(await loadDashboard(user, deps)).toEqual(error);
    github.failNext(new TypeError("fetch failed"));
    expect(await loadDashboard(user, deps)).toEqual(error);
    github.failNext(Response.json({ total_count: 1, installations: [{ id: "x" }] }));
    expect(await loadDashboard(user, deps)).toEqual(error);
    github.install(OCTO, [{ ...OWN, repos: [{ owner: "octo", name: "../etc" }] }]);
    expect(await loadDashboard(user, deps)).toEqual(error);
    expect(await findSession(t.db, tokenHash)).toBeDefined();
  });

  it("says GitHub can't be read when a refresh fails without a refusal", async () => {
    const { github, deps, user, tokenHash } = await signedIn({ accessIn: 0 });
    github.failNext(new TypeError("fetch failed"));
    expect(await loadDashboard(user, deps)).toEqual({ kind: "error" });
    expect(await findSession(t.db, tokenHash)).toBeDefined();
  });
});

describe("GitHub links", () => {
  it("installs the app, and opens an installation's settings for a user or an organization", () => {
    expect(installUrl("gitinside")).toBe("https://github.com/apps/gitinside/installations/new");
    const base = { selection: "all" as const, repos: [], totalRepos: 0 };
    expect(installationSettingsUrl({ ...base, id: 7, account: "octo", accountType: "User" })).toBe(
      "https://github.com/settings/installations/7",
    );
    expect(
      installationSettingsUrl({ ...base, id: 41, account: "acme", accountType: "Organization" }),
    ).toBe("https://github.com/organizations/acme/settings/installations/41");
  });
});
