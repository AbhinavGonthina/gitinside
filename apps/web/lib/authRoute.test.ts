// @vitest-environment node
import { findInstallation, installations, sessions, users } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_PATH,
  handleCallback,
  handleSignIn,
  handleSignOut,
  readSession,
  type AuthDeps,
} from "./authRoute";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  REFRESH_EXPIRES_IN,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import {
  hashToken,
  SESSION_COOKIE,
  SESSION_LIFETIME_SECONDS,
  sessionKeys,
  STATE_COOKIE,
  STATE_LIFETIME_SECONDS,
} from "./session";

const SITE = "https://gitinside.test";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OCTO = { id: 3_000_000_007, login: "octo" };

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
  await t.db.delete(installations);
  vi.restoreAllMocks();
});

function setup(options: { expiring?: boolean; now?: number } = {}) {
  const github = fakeOAuth(options);
  let now = options.now ?? NOW;
  const deps: AuthDeps = {
    db: t.db,
    client: { ...FAKE_CLIENT, fetch: github.fetch },
    keys: sessionKeys("s".repeat(43)),
    now: () => now,
  };
  return { github, deps, advance: (ms: number) => (now += ms) };
}

/** The `Set-Cookie` values of `response`, by cookie name. */
function setCookies(response: Response): Map<string, string> {
  const map = new Map<string, string>();
  for (const value of response.headers.getSetCookie()) {
    map.set(value.slice(0, value.indexOf("=")), value);
  }
  return map;
}

const cookieValue = (setCookie: string | undefined) =>
  setCookie?.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));

/** Start signing in; returns GitHub's authorize URL and the state cookie for the callback. */
function start(deps: AuthDeps, returnTo?: string) {
  const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = handleSignIn(new Request(`${SITE}/api/auth/github${query}`), deps);
  expect(response.status).toBe(303);
  const authorize = response.headers.get("location") ?? "";
  const state = setCookies(response).get(STATE_COOKIE);
  return { response, authorize, stateCookie: `${STATE_COOKIE}=${cookieValue(state)}` };
}

function callback(params: Record<string, string>, cookie?: string): Request {
  const url = new URL(CALLBACK_PATH, SITE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, cookie === undefined ? {} : { headers: { cookie } });
}

/** Sign `account` in all the way; returns the callback's response. */
async function signIn(github: FakeOAuth, deps: AuthDeps, returnTo?: string) {
  const { authorize, stateCookie } = start(deps, returnTo);
  const state = new URL(authorize).searchParams.get("state") ?? "";
  const code = github.approve(authorize, OCTO);
  return handleCallback(callback({ code, state }, stateCookie), deps);
}

describe("handleSignIn", () => {
  it("sends the browser to GitHub with state, a PKCE challenge, and this site's callback", () => {
    const { deps } = setup();
    const { response, authorize } = start(deps, "/acme/shop");
    const url = new URL(authorize);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: FAKE_CLIENT.clientId,
      redirect_uri: `${SITE}${CALLBACK_PATH}`,
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    expect(setCookies(response).get(STATE_COOKIE)).toMatch(
      new RegExp(`; Path=/; Max-Age=${STATE_LIFETIME_SECONDS}; HttpOnly; Secure; SameSite=Lax$`),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("builds the callback from the Host the browser used, not the server's own URL (M8.2b)", () => {
    // `next start` hands route handlers `http://localhost:<port>` whatever host was asked for.
    const { deps } = setup();
    const redirectUri = (headers: Record<string, string>) => {
      const response = handleSignIn(
        new Request("http://localhost:3000/api/auth/github", { headers }),
        deps,
      );
      return new URL(response.headers.get("location") ?? "").searchParams.get("redirect_uri");
    };
    expect(redirectUri({ host: "127.0.0.1:3000" })).toBe(`http://127.0.0.1:3000${CALLBACK_PATH}`);
    expect(redirectUri({ host: "internal:80", "x-forwarded-host": "gitinside.test, proxy" })).toBe(
      `http://gitinside.test${CALLBACK_PATH}`,
    );
    expect(redirectUri({ host: "gitinside.test", "x-forwarded-proto": "https" })).toBe(
      `${SITE}${CALLBACK_PATH}`,
    );
    // Anything that isn't a plain host (or protocol) is ignored for the URL's own.
    expect(redirectUri({ host: "evil.example/x?", "x-forwarded-proto": "javascript" })).toBe(
      `http://localhost:3000${CALLBACK_PATH}`,
    );
  });

  it("says sign-in is unavailable when the server isn't configured", async () => {
    const response = handleSignIn(new Request(`${SITE}/api/auth/github`), undefined);
    expect(response.headers.get("location")).toBe("/?signin=unavailable");
    const back = await handleCallback(callback({ code: "x", state: "y" }), undefined);
    expect(back.headers.get("location")).toBe("/?signin=unavailable");
  });
});

describe("handleCallback", () => {
  it("stores the user and a session, sets the cookie, and returns where sign-in started", async () => {
    const { github, deps } = setup();
    const response = await signIn(github, deps, "/acme/shop?x=1");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/acme/shop?x=1");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = setCookies(response);
    expect(cookies.get(STATE_COOKIE)).toContain("Max-Age=0");
    const session = cookies.get(SESSION_COOKIE) ?? "";
    // The refresh token outlives 30 days, so the session lasts 30 days.
    expect(session).toMatch(
      new RegExp(
        `^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=${SESSION_LIFETIME_SECONDS}; HttpOnly; Secure; SameSite=Lax$`,
      ),
    );
    const token = cookieValue(session) ?? "";

    const [row] = await t.db.select().from(sessions);
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(row?.githubTokens).not.toContain("ghu_");
    expect(row?.githubTokens).not.toContain("ghr_");

    const user = await readSession(`${SESSION_COOKIE}=${token}`, deps);
    expect(user).toMatchObject({ githubUserId: OCTO.id, login: "octo" });
    expect(user?.tokens()).toEqual({
      accessToken: expect.stringMatching(/^ghu_/),
      accessExpiresAt: NOW + EXPIRES_IN * 1000,
      refreshToken: expect.stringMatching(/^ghr_/),
      refreshExpiresAt: NOW + REFRESH_EXPIRES_IN * 1000,
    });
  });

  it("keeps a session no longer than GitHub's refresh token, and 30 days when tokens don't expire", async () => {
    const short = setup();
    short.deps.client.fetch = async (input, init) => {
      const response = await short.github.fetch(input, init);
      if (!new Request(input, init).url.endsWith("/access_token")) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...body, refresh_token_expires_in: 3600 });
    };
    const cut = await signIn(short.github, short.deps);
    expect(setCookies(cut).get(SESSION_COOKIE)).toContain("; Max-Age=3600;");

    const plain = setup({ expiring: false });
    const response = await signIn(plain.github, plain.deps);
    expect(setCookies(response).get(SESSION_COOKIE)).toContain(
      `; Max-Age=${SESSION_LIFETIME_SECONDS};`,
    );
    const token = cookieValue(setCookies(response).get(SESSION_COOKIE));
    const user = await readSession(`${SESSION_COOKIE}=${token}`, plain.deps);
    expect(user?.tokens()).toMatchObject({ accessExpiresAt: null, refreshToken: null });
  });

  it("refuses a callback without its state cookie, with another state, or after 10 minutes", async () => {
    const { github, deps, advance } = setup();
    const { authorize, stateCookie } = start(deps);
    const state = new URL(authorize).searchParams.get("state") ?? "";
    const code = github.approve(authorize, OCTO);

    const noCookie = await handleCallback(callback({ code, state }), deps);
    expect(noCookie.headers.get("location")).toBe("/?signin=failed");
    const otherState = await handleCallback(
      callback({ code, state: `${state}x` }, stateCookie),
      deps,
    );
    expect(otherState.headers.get("location")).toBe("/?signin=failed");
    const forged = await handleCallback(callback({ code, state }, `${stateCookie}x`), deps);
    expect(forged.headers.get("location")).toBe("/?signin=expired");
    advance(STATE_LIFETIME_SECONDS * 1000 + 1);
    const late = await handleCallback(callback({ code, state }, stateCookie), deps);
    expect(late.headers.get("location")).toBe("/?signin=expired");

    // GitHub was never asked, and nobody signed in.
    expect(github.requests).toEqual([]);
    expect(await t.db.select().from(sessions)).toEqual([]);
    for (const response of [noCookie, otherState, forged, late]) {
      expect(setCookies(response).get(SESSION_COOKIE)).toBeUndefined();
      expect(setCookies(response).get(STATE_COOKIE)).toContain("Max-Age=0");
    }
  });

  it("goes home signed out when the user cancels or GitHub refuses the code", async () => {
    const { deps } = setup();
    const { authorize, stateCookie } = start(deps);
    const state = new URL(authorize).searchParams.get("state") ?? "";
    const cancelled = await handleCallback(
      callback({ error: "access_denied", state }, stateCookie),
      deps,
    );
    expect(cancelled.headers.get("location")).toBe("/?signin=cancelled");

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const wrong = await handleCallback(
      callback({ code: "never-issued", state }, stateCookie),
      deps,
    );
    expect(wrong.headers.get("location")).toBe("/?signin=failed");
    expect(errors).toHaveBeenCalledWith(
      JSON.stringify({ event: "signin_failed", error: "exchange refused (bad_verification_code)" }),
    );
    const malformed = await handleCallback(callback({ code: "a b", state }, stateCookie), deps);
    expect(malformed.headers.get("location")).toBe("/?signin=failed");
    expect(await t.db.select().from(users)).toEqual([]);
  });

  it("checks the PKCE verifier and the redirect URI GitHub issued the code for", async () => {
    const { github, deps } = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A code issued to another sign-in (another challenge) doesn't redeem with this state.
    const first = start(deps);
    const second = start(deps);
    const state = new URL(second.authorize).searchParams.get("state") ?? "";
    const code = github.approve(first.authorize, OCTO);
    const crossed = await handleCallback(callback({ code, state }, second.stateCookie), deps);
    expect(crossed.headers.get("location")).toBe("/?signin=failed");

    // The callback reached through another origin sends another redirect URI.
    const third = start(deps);
    const thirdState = new URL(third.authorize).searchParams.get("state") ?? "";
    const thirdCode = github.approve(third.authorize, OCTO);
    const elsewhere = new Request(
      `https://elsewhere.test${CALLBACK_PATH}?code=${thirdCode}&state=${thirdState}`,
      { headers: { cookie: third.stateCookie } },
    );
    expect((await handleCallback(elsewhere, deps)).headers.get("location")).toBe("/?signin=failed");
    expect(errors).toHaveBeenCalledTimes(2);
    expect(await t.db.select().from(sessions)).toEqual([]);
  });

  it("fails visibly, logging only the kind, when GitHub or the database fails", async () => {
    const { github, deps } = setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    github.failNext(new Response("down", { status: 502 }));
    expect((await signIn(github, deps)).headers.get("location")).toBe("/?signin=failed");
    github.failNext(new TypeError("fetch failed"));
    expect((await signIn(github, deps)).headers.get("location")).toBe("/?signin=failed");
    const broken: AuthDeps = {
      ...deps,
      db: new Proxy({} as AuthDeps["db"], {
        get() {
          throw new Error("postgres://user:secret@host/db unreachable");
        },
      }),
    };
    expect((await signIn(github, broken)).headers.get("location")).toBe("/?signin=failed");
    expect(errors.mock.calls.map(([line]) => line)).toEqual([
      JSON.stringify({ event: "signin_failed", error: "HTTP 502" }),
      JSON.stringify({ event: "signin_failed", error: "TypeError" }),
      JSON.stringify({ event: "signin_failed", error: "Error" }),
    ]);
  });
});

describe("handleCallback: the install return (M8.3b)", () => {
  const ACME = {
    id: 41,
    account: { id: 9_001, login: "acme", type: "Organization" as const },
    repos: [],
  };

  /** A signed-in visitor: their session cookie, and the requests made after signing in. */
  async function signedIn(github: FakeOAuth, deps: AuthDeps) {
    const response = await signIn(github, deps);
    const cookie = `${SESSION_COOKIE}=${cookieValue(setCookies(response).get(SESSION_COOKIE))}`;
    github.requests.length = 0;
    return cookie;
  }

  /** GitHub's redirect after installing: a code, the installation, and no `state` of ours. */
  const installReturn = (params: Record<string, string>, cookie?: string) =>
    callback({ code: "issued-on-github", setup_action: "install", ...params }, cookie);

  it("records an installation GitHub lists for the user, from GitHub's answer, never redeeming the code", async () => {
    const { github, deps } = setup();
    const cookie = await signedIn(github, deps);
    github.install(OCTO, [ACME]);
    const response = await handleCallback(installReturn({ installation_id: "41" }, cookie), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard?install=installed&installation=41");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Neither the session nor a sign-in in progress is touched.
    expect(setCookies(response).size).toBe(0);
    expect(await findInstallation(t.db, 41)).toEqual({
      id: expect.any(String),
      githubInstallationId: 41,
      accountId: 9_001,
      accountLogin: "acme",
      accountType: "Organization",
      suspendedAt: null,
    });
    // Only the user's installations were read: the code from the query was never exchanged.
    expect(github.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /user/installations",
    ]);

    // Changing it on GitHub (`update`) stores what GitHub says now, suspension included.
    github.install(OCTO, [{ ...ACME, suspendedAt: "2026-11-07T11:00:00Z" }]);
    const updated = await handleCallback(
      installReturn({ installation_id: "41", setup_action: "update" }, cookie),
      deps,
    );
    expect(updated.headers.get("location")).toBe("/dashboard?install=updated&installation=41");
    expect((await findInstallation(t.db, 41))?.suspendedAt).toEqual(
      new Date("2026-11-07T11:00:00Z"),
    );
  });

  it("never trusts the query: an installation the user can't see changes nothing", async () => {
    const { github, deps } = setup();
    const cookie = await signedIn(github, deps);
    github.install(OCTO, [{ ...ACME, id: 42 }]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleCallback(installReturn({ installation_id: "41" }, cookie), deps);
    expect(response.headers.get("location")).toBe("/dashboard?install=unverified");
    expect(await t.db.select().from(installations)).toEqual([]);
    expect(errors).toHaveBeenCalledWith(JSON.stringify({ event: "install_return_unverified" }));
  });

  it("looks past GitHub's first page of the user's installations", async () => {
    const { github, deps } = setup();
    const cookie = await signedIn(github, deps);
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...ACME,
      id: 100 + i,
      account: { login: `org${i}`, type: "Organization" as const },
    }));
    github.install(OCTO, many);
    const response = await handleCallback(installReturn({ installation_id: "245" }, cookie), deps);
    expect(response.headers.get("location")).toBe("/dashboard?install=installed&installation=245");
    expect((await findInstallation(t.db, 245))?.accountLogin).toBe("org145");
    expect(github.requests.map((r) => new URL(r.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("signs a signed-out installer in through this site's own flow first, then comes back", async () => {
    const { github, deps } = setup();
    github.install(OCTO, [ACME]);
    const first = await handleCallback(installReturn({ installation_id: "41" }), deps);
    const location = new URL(first.headers.get("location") ?? "", SITE);
    expect(location.pathname).toBe("/api/auth/github");
    const returnTo = location.searchParams.get("returnTo") ?? "";
    expect(returnTo).toBe(`${CALLBACK_PATH}?installation_id=41&setup_action=install&after=signin`);
    // Without our state, the code could be anyone's (login CSRF): it's never exchanged.
    expect(github.requests).toEqual([]);
    expect(await t.db.select().from(sessions)).toEqual([]);

    const back = await signIn(github, deps, returnTo);
    expect(back.headers.get("location")).toBe(returnTo);
    const cookie = `${SESSION_COOKIE}=${cookieValue(setCookies(back).get(SESSION_COOKIE))}`;
    const done = await handleCallback(
      new Request(new URL(returnTo, SITE), { headers: { cookie } }),
      deps,
    );
    expect(done.headers.get("location")).toBe("/dashboard?install=installed&installation=41");
    expect(await findInstallation(t.db, 41)).toBeDefined();

    // Still signed out on coming back (the session didn't stick): stop rather than loop.
    const again = await handleCallback(new Request(new URL(returnTo, SITE)), deps);
    expect(again.headers.get("location")).toBe("/?signin=failed");
  });

  it("says an organization member's request was sent, and ignores what it can't read", async () => {
    const { github, deps } = setup();
    const cookie = await signedIn(github, deps);
    const requested = await handleCallback(callback({ setup_action: "request" }, cookie), deps);
    expect(requested.headers.get("location")).toBe("/dashboard?install=requested");
    for (const params of [
      { installation_id: "41", setup_action: "uninstall" },
      { installation_id: "abc" },
      { installation_id: "0" },
      { installation_id: "041" },
      { installation_id: "99999999999999999" },
      {},
    ]) {
      const response = await handleCallback(installReturn(params, cookie), deps);
      expect(response.headers.get("location"), JSON.stringify(params)).toBe("/dashboard");
    }
    expect(github.requests).toEqual([]);
    expect(await t.db.select().from(installations)).toEqual([]);
  });

  it("fails visibly when GitHub or the database fails, and signs out a refused token", async () => {
    const { github, deps } = setup();
    const cookie = await signedIn(github, deps);
    github.install(OCTO, [ACME]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ask = (d: AuthDeps = deps) =>
      handleCallback(installReturn({ installation_id: "41" }, cookie), d);

    github.failNext(new Response("down", { status: 502 }));
    expect((await ask()).headers.get("location")).toBe("/dashboard?install=failed");
    github.install(OCTO, [{ ...ACME, account: { ...ACME.account, login: "-bad-" } }]);
    expect((await ask()).headers.get("location")).toBe("/dashboard?install=failed");
    github.install(OCTO, [ACME]);
    const noInsert: AuthDeps = {
      ...deps,
      db: new Proxy(t.db, {
        get(target, property, receiver) {
          if (property === "insert") throw new Error("postgres://user:secret@host/db unreachable");
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };
    expect((await ask(noInsert)).headers.get("location")).toBe("/dashboard?install=failed");
    expect(await t.db.select().from(installations)).toEqual([]);
    expect(errors.mock.calls.map(([line]) => line)).toEqual([
      JSON.stringify({ event: "install_return_failed", error: "HTTP 502" }),
      JSON.stringify({ event: "install_return_failed", error: "installation without an account" }),
      JSON.stringify({ event: "install_return_failed", error: "Error" }),
    ]);

    // The user revoked the app on GitHub: the session ends, as on the dashboard.
    const user = await readSession(cookie, deps);
    github.revoke(user?.tokens()?.accessToken ?? "");
    expect((await ask()).headers.get("location")).toBe("/?signin=ended");
    expect(await readSession(cookie, deps)).toBeUndefined();
  });
});

describe("readSession", () => {
  it("is signed out without a cookie, with an unknown or ended session, or when unconfigured", async () => {
    const { github, deps, advance } = setup();
    expect(await readSession(null, deps)).toBeUndefined();
    expect(await readSession(`${SESSION_COOKIE}=${"a".repeat(43)}`, deps)).toBeUndefined();
    const response = await signIn(github, deps);
    const cookie = `${SESSION_COOKIE}=${cookieValue(setCookies(response).get(SESSION_COOKIE))}`;
    expect(await readSession(cookie, undefined)).toBeUndefined();
    expect(await readSession(cookie, deps)).toBeDefined();
    advance(1); // the deps' clock doesn't end sessions: the database's does
    await t.db.update(sessions).set({
      createdAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await readSession(cookie, deps)).toBeUndefined();
  });

  it("gives no tokens when the session secret changed, and survives a database failure", async () => {
    const { github, deps } = setup();
    const response = await signIn(github, deps);
    const cookie = `${SESSION_COOKIE}=${cookieValue(setCookies(response).get(SESSION_COOKIE))}`;
    const rotated = { ...deps, keys: sessionKeys("t".repeat(43)) };
    const user = await readSession(cookie, rotated);
    expect(user?.login).toBe("octo");
    expect(user?.tokens()).toBeUndefined();

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      ...deps,
      db: new Proxy({} as AuthDeps["db"], {
        get: () => {
          throw new Error("x");
        },
      }),
    };
    expect(await readSession(cookie, broken)).toBeUndefined();
  });
});

describe("handleSignOut", () => {
  async function signedIn() {
    const { github, deps } = setup();
    const response = await signIn(github, deps);
    const cookie = `${SESSION_COOKIE}=${cookieValue(setCookies(response).get(SESSION_COOKIE))}`;
    return { deps, cookie };
  }
  const post = (cookie: string, origin: string | null = SITE) =>
    new Request(`${SITE}/api/auth/signout`, {
      method: "POST",
      headers: { cookie, ...(origin === null ? {} : { origin }) },
    });

  it("deletes the session and clears the cookie", async () => {
    const { deps, cookie } = await signedIn();
    const response = await handleSignOut(post(cookie), deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(setCookies(response).get(SESSION_COOKIE)).toBe(
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(await readSession(cookie, deps)).toBeUndefined();
    expect(await t.db.select().from(sessions)).toEqual([]);
  });

  it("refuses a POST from another site or without an Origin", async () => {
    const { deps, cookie } = await signedIn();
    for (const origin of ["https://evil.example", "null", null]) {
      const response = await handleSignOut(post(cookie, origin), deps);
      expect(response.status, String(origin)).toBe(403);
      expect(setCookies(response).size).toBe(0);
    }
    expect(await readSession(cookie, deps)).toBeDefined();
  });

  it("compares the Origin with the Host the browser used, not the server's own URL (M8.2b)", async () => {
    // A real browser's form POST through `next start` (whose request URL says `localhost`).
    const { deps, cookie } = await signedIn();
    const local = (origin: string) =>
      new Request("http://localhost:3491/api/auth/signout", {
        method: "POST",
        headers: { cookie, origin, host: "127.0.0.1:3491" },
      });
    const elsewhere = await handleSignOut(local("http://evil.example"), deps);
    expect(elsewhere.status).toBe(403);
    const response = await handleSignOut(local("http://127.0.0.1:3491"), deps);
    expect(response.status).toBe(303);
    expect(await readSession(cookie, deps)).toBeUndefined();
  });

  it("clears the cookie even when signed out or unconfigured, and keeps it if the delete fails", async () => {
    const { deps, cookie } = await signedIn();
    const anonymous = await handleSignOut(post(""), deps);
    expect(setCookies(anonymous).get(SESSION_COOKIE)).toContain("Max-Age=0");
    const unconfigured = await handleSignOut(post(cookie), undefined);
    expect(setCookies(unconfigured).get(SESSION_COOKIE)).toContain("Max-Age=0");

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = {
      ...deps,
      db: new Proxy({} as AuthDeps["db"], {
        get: () => {
          throw new Error("x");
        },
      }),
    };
    const failed = await handleSignOut(post(cookie), broken);
    expect(failed.headers.get("location")).toBe("/?signout=failed");
    expect(setCookies(failed).size).toBe(0);
  });
});
