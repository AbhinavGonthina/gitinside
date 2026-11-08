// @vitest-environment node
import {
  ACCESS_TTL_SECONDS,
  accessCache,
  analyses,
  completeAnalysis,
  createSession,
  findSession,
  repos,
  sessions,
  startAnalysis,
  upsertRepo,
  upsertUser,
  users,
} from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "./authRoute";
import {
  EXPIRES_IN,
  FAKE_CLIENT,
  fakeOAuth,
  type FakeAccount,
  type FakeInstallation,
  type FakeOAuth,
} from "./githubOAuth.testkit";
import { UNAVAILABLE_MESSAGE } from "./messages";
import { hashToken, newToken, SESSION_COOKIE, sealTokens, sessionKeys } from "./session";
import { handleSourceRequest, MAX_FILE_BYTES } from "./sourceRoute";

const SHA = "d".repeat(40);
const OTHER_SHA = "e".repeat(40);
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const OCTO: FakeAccount = { id: 3_000_000_007, login: "octo" };
const HUBOT: FakeAccount = { id: 3_000_000_008, login: "hubot" };
const KEYS = sessionKeys("s".repeat(43));
const FILES: Record<string, string> = {
  "src/app.ts": "export const app = 1;\n",
  "src/a b/#x.ts": "export const odd = 2;\n",
};
const ACME: FakeInstallation = {
  id: 41,
  account: { login: "acme", type: "Organization" },
  selection: "selected",
  repos: [
    {
      owner: "Acme",
      name: "Shop",
      private: true,
      id: 1,
      file: (path, ref) => (ref === SHA ? FILES[path] : undefined),
    },
  ],
};

let t: TestDb;
let github: FakeOAuth;
let auth: AuthDeps;

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
  await t.db.delete(analyses);
  await t.db.delete(repos);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  github = fakeOAuth();
  github.install(OCTO, [ACME]);
  auth = { db: t.db, client: { ...FAKE_CLIENT, fetch: github.fetch }, keys: KEYS, now: () => NOW };
  await publish("private");
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function publish(visibility: "public" | "private") {
  const { id: repoId } = await upsertRepo(t.db, {
    providerRepoId: 1,
    owner: "Acme",
    name: "Shop",
    visibility,
    defaultBranch: "main",
  });
  const { id } = await startAnalysis(t.db, { repoId, sha: SHA, analyzerVersion: "0.1.0" });
  await completeAnalysis(t.db, id, {
    snapshotKey: `private/41/${repoId}/${SHA}/0.1.0.json.gz`,
    stats: { files: 0, nodes: 0, edges: 0, unresolved: 0 },
  });
}

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
  return { cookie: `theme=dark; ${SESSION_COOKIE}=${token}`, tokenHash, issued };
}

const params = (path = ["src", "app.ts"], owner = "Acme", repo = "Shop", sha = SHA) => ({
  owner,
  repo,
  sha,
  path,
});

/** Everything a client can see of a response. */
async function seen(response: Response) {
  return { status: response.status, headers: [...response.headers], body: await response.text() };
}

/** What a repo nobody analyzed answers: every refusal must look exactly like it. */
async function missing() {
  return seen(await handleSourceRequest(params(undefined, "Acme", "Nothing"), auth, null));
}

const fileReads = () => github.requests.filter((r) => r.url.includes("/contents/"));
const lookups = () => github.requests.filter((r) => /\/repositories\/\d+$/.test(r.url)).length;

describe("handleSourceRequest (M8.4c3)", () => {
  it("serves the file at the commit to a user GitHub shows the repo to, never cacheable", async () => {
    const { cookie } = await signIn(OCTO);
    const response = await handleSourceRequest(params(), auth, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(FILES["src/app.ts"]);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      vary: "cookie",
      "x-content-type-options": "nosniff",
    });
    // By GitHub's ID, at the analyzed commit (the fake answers only a user's token).
    expect(fileReads().map((r) => r.url)).toEqual([
      `https://api.github.com/repositories/1/contents/src/app.ts?ref=${SHA}`,
    ]);

    // Encoded segments reach GitHub encoded; the access check comes from the 60 s cache.
    const odd = await handleSourceRequest(params(["src", "a b", "#x.ts"]), auth, cookie);
    expect(await odd.text()).toBe(FILES["src/a b/#x.ts"]);
    expect(fileReads().at(-1)?.url).toBe(
      `https://api.github.com/repositories/1/contents/src/a%20b/%23x.ts?ref=${SHA}`,
    );
    expect(lookups()).toBe(1);
  });

  it("answers signed out, without sign-in, or with a dead cookie exactly as missing", async () => {
    const expected = await missing();
    expect(expected.status).toBe(404);
    expect(expected.headers).toContainEqual(["cache-control", "private, no-store"]);
    const { cookie } = await signIn(OCTO);
    const cases: [string, AuthDeps | undefined, string | null][] = [
      ["signed out", auth, null],
      ["sign-in not configured", undefined, cookie],
      ["no such session", auth, `${SESSION_COOKIE}=${newToken()}`],
    ];
    for (const [name, a, c] of cases) {
      expect(await seen(await handleSourceRequest(params(), a, c)), name).toEqual(expected);
    }
    expect(github.requests).toEqual([]);
  });

  it("refuses another signed-in user exactly as missing, never reading the file", async () => {
    const hubot = await signIn(HUBOT);
    expect(await seen(await handleSourceRequest(params(), auth, hubot.cookie))).toEqual(
      await missing(),
    );
    expect(fileReads()).toEqual([]);
  });

  it("refuses access removed on GitHub once the check is 60 s old", async () => {
    const { cookie } = await signIn(OCTO);
    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(200);
    github.install(OCTO, []);
    const [row] = await t.db.select().from(accessCache);
    await t.db.update(accessCache).set({
      checkedAt: new Date((row?.checkedAt.getTime() ?? 0) - ACCESS_TTL_SECONDS * 1000),
    });
    expect(await seen(await handleSourceRequest(params(), auth, cookie))).toEqual(await missing());
    expect(fileReads()).toHaveLength(1);
  });

  it("ends the session when GitHub refuses the user's token, answering as missing", async () => {
    const { cookie, tokenHash, issued } = await signIn(OCTO);
    github.revoke(issued.accessToken);
    expect(await seen(await handleSourceRequest(params(), auth, cookie))).toEqual(await missing());
    expect(await findSession(t.db, tokenHash)).toBeUndefined();
    expect(fileReads()).toEqual([]);
  });

  it("is never a proxy for a public repo's files, or a commit nobody analyzed", async () => {
    const { cookie } = await signIn(OCTO);
    const expected = await missing();
    expect(
      await seen(
        await handleSourceRequest(params(undefined, "Acme", "Shop", OTHER_SHA), auth, cookie),
      ),
    ).toEqual(expected);
    await publish("public");
    expect(await seen(await handleSourceRequest(params(), auth, cookie))).toEqual(expected);
    expect(github.requests).toEqual([]);
  });

  it("refuses a path that could leave the repo, and a malformed name or SHA, asking nothing", async () => {
    const { cookie } = await signIn(OCTO);
    const expected = await missing();
    const bad = [
      params([]),
      params([".."]),
      params(["src", "..", "app.ts"]),
      params([".", "app.ts"]),
      params(["src", "", "app.ts"]),
      params(["src/app.ts"]),
      params(undefined, "Acme", "Shop", "D".repeat(40)),
      params(undefined, "Acme", "Shop", "main"),
      params(undefined, "-acme", "Shop"),
    ];
    for (const p of bad) {
      expect(await seen(await handleSourceRequest(p, auth, cookie)), JSON.stringify(p)).toEqual(
        expected,
      );
    }
    expect(github.requests).toEqual([]);
  });

  it("is missing for a file that isn't at the commit", async () => {
    const { cookie } = await signIn(OCTO);
    const response = await handleSourceRequest(params(["src", "gone.ts"]), auth, cookie);
    expect(await seen(response)).toEqual(await missing());
  });

  it("is unavailable when the check can't decide, or GitHub fails the read; the next view asks again", async () => {
    const { cookie } = await signIn(OCTO);
    github.failNext(new Response("oops", { status: 502 }));
    const undecided = await handleSourceRequest(params(), auth, cookie);
    expect(undecided.status).toBe(503);
    expect(await undecided.json()).toEqual({ error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });
    expect(fileReads()).toEqual([]);

    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(200);
    github.failNext(new Response("oops", { status: 500 }));
    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(503);
    github.failNext(new Response("slow down", { status: 403, headers: { "retry-after": "60" } }));
    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(503);
    github.failNext(new TypeError("fetch failed"));
    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "source_read_failed", status: 500 }),
    );
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "source_failed", error: "TypeError" }),
    );
  });

  it("refuses a file over the cap, by its length or while it streams", async () => {
    expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
    const { cookie } = await signIn(OCTO);
    const tooLarge = { error: "SOURCE_TOO_LARGE", message: "That file is too large to preview." };
    // The check is cached first, so the fake's next answers are the file reads.
    expect((await handleSourceRequest(params(), auth, cookie)).status).toBe(200);

    github.failNext(new Response("ab", { headers: { "content-length": "5" } }));
    const declared = await handleSourceRequest(params(), auth, cookie, 4);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual(tooLarge);

    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(3).fill(0x61)),
      cancel: () => {
        cancelled = true;
      },
    });
    github.failNext(new Response(endless));
    const streamed = await handleSourceRequest(params(), auth, cookie, 4);
    expect(streamed.status).toBe(413);
    expect(cancelled).toBe(true);

    expect(await (await handleSourceRequest(params(), auth, cookie, 22)).text()).toBe(
      FILES["src/app.ts"],
    );
  });
});
