// @vitest-environment node
import { createSession, upsertUser } from "@gitinside/db";
import { createTestDb, type TestDb } from "@gitinside/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "./authRoute";
import { FAKE_CLIENT } from "./githubOAuth.testkit";
import { hashToken, newToken, SESSION_COOKIE, sessionKeys } from "./session";

const state: { auth: AuthDeps | undefined; cookie: string | null } = {
  auth: undefined,
  cookie: null,
};
vi.mock("./serverDeps", () => ({ authDepsFromEnv: () => state.auth }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.cookie === null ? {} : { cookie: state.cookie }),
}));

const { currentSignIn } = await import("./currentUser");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  state.auth = { db: t.db, client: FAKE_CLIENT, keys: sessionKeys("s".repeat(43)) };
  state.cookie = null;
});

describe("currentSignIn (M8.2b)", () => {
  it("is unavailable, asking nothing, while sign-in isn't set up", async () => {
    state.auth = undefined;
    state.cookie = `${SESSION_COOKIE}=${newToken()}`;
    expect(await currentSignIn()).toEqual({ available: false });
  });

  it("is signed out without a cookie, or with one that names no live session", async () => {
    expect(await currentSignIn()).toEqual({ available: true });
    state.cookie = `${SESSION_COOKIE}=${newToken()}`;
    expect(await currentSignIn()).toEqual({ available: true });
  });

  it("names the login of the session the cookie holds", async () => {
    const userId = await upsertUser(t.db, { githubUserId: 9, login: "octo" });
    const token = newToken();
    await createSession(t.db, {
      userId,
      tokenHash: hashToken(token),
      githubTokens: "sealed",
      lifetimeSeconds: 60,
    });
    state.cookie = `theme=dark; ${SESSION_COOKIE}=${token}`;
    expect(await currentSignIn()).toEqual({ available: true, login: "octo" });
  });
});
