// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  hashToken,
  newToken,
  openTokens,
  readCookie,
  safeReturnTo,
  sealTokens,
  SESSION_COOKIE,
  sessionKeys,
  sessionToken,
  signState,
  STATE_LIFETIME_SECONDS,
  verifyState,
} from "./session";

const KEYS = sessionKeys("s".repeat(43));
const TOKENS = {
  accessToken: "ghu_x",
  accessExpiresAt: 1,
  refreshToken: "ghr_y",
  refreshExpiresAt: 2,
};

describe("session tokens", () => {
  it("are 32 random bytes, stored only as their SHA-256", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("are read from the cookie only when well formed", () => {
    const token = newToken();
    expect(sessionToken(`a=1; ${SESSION_COOKIE}=${token}; b=2`)).toBe(token);
    expect(sessionToken(`${SESSION_COOKIE}=${token}x`)).toBeUndefined();
    expect(sessionToken(`${SESSION_COOKIE}=../../etc`)).toBeUndefined();
    expect(sessionToken(`x${SESSION_COOKIE}=${token}`)).toBeUndefined();
    expect(sessionToken(null)).toBeUndefined();
    expect(readCookie("a=b=c", "a")).toBe("b=c");
  });
});

describe("sealed GitHub tokens", () => {
  it("open only under the same key and for the same session", () => {
    const sealed = sealTokens(KEYS, "a".repeat(64), TOKENS);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("ghu_x");
    expect(sealTokens(KEYS, "a".repeat(64), TOKENS)).not.toBe(sealed); // fresh IV
    expect(openTokens(KEYS, "a".repeat(64), sealed)).toEqual(TOKENS);
    expect(openTokens(KEYS, "b".repeat(64), sealed)).toBeUndefined();
    expect(openTokens(sessionKeys("t".repeat(43)), "a".repeat(64), sealed)).toBeUndefined();
  });

  it("don't open once changed", () => {
    const sealed = sealTokens(KEYS, "a".repeat(64), TOKENS);
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    bytes[20] = (bytes[20] ?? 0) ^ 1;
    expect(openTokens(KEYS, "a".repeat(64), `v1.${bytes.toString("base64url")}`)).toBeUndefined();
    expect(openTokens(KEYS, "a".repeat(64), "v1.AAAA")).toBeUndefined();
    expect(openTokens(KEYS, "a".repeat(64), "v2.AAAA")).toBeUndefined();
  });
});

describe("the sign-in state cookie", () => {
  const STATE = {
    state: newToken(),
    verifier: newToken(),
    returnTo: "/acme/shop",
    startedAt: 1e12,
  };

  it("holds while signed, well formed, and younger than its lifetime", () => {
    const value = signState(KEYS, STATE);
    expect(verifyState(KEYS, value, STATE.startedAt)).toEqual(STATE);
    expect(verifyState(KEYS, value, STATE.startedAt + STATE_LIFETIME_SECONDS * 1000)).toEqual(
      STATE,
    );
    expect(
      verifyState(KEYS, value, STATE.startedAt + STATE_LIFETIME_SECONDS * 1000 + 1),
    ).toBeUndefined();
    expect(verifyState(KEYS, value, STATE.startedAt - 1)).toBeUndefined();
    expect(verifyState(sessionKeys("t".repeat(43)), value, STATE.startedAt)).toBeUndefined();
    expect(verifyState(KEYS, undefined, STATE.startedAt)).toBeUndefined();
  });

  it("refuses a changed payload or MAC, and an unsafe returnTo is replaced", () => {
    const [payload, signature] = signState(KEYS, STATE).split(".") as [string, string];
    const other = Buffer.from(JSON.stringify({ ...STATE, returnTo: "/x" })).toString("base64url");
    expect(verifyState(KEYS, `${other}.${signature}`, STATE.startedAt)).toBeUndefined();
    expect(verifyState(KEYS, `${payload}.${signature}A`, STATE.startedAt)).toBeUndefined();
    expect(verifyState(KEYS, `${payload}.${signature}.x`, STATE.startedAt)).toBeUndefined();
    const short = signState(KEYS, { ...STATE, verifier: "short" });
    expect(verifyState(KEYS, short, STATE.startedAt)).toBeUndefined();
    const away = signState(KEYS, { ...STATE, returnTo: "https://evil.example/" });
    expect(verifyState(KEYS, away, STATE.startedAt)?.returnTo).toBe("/");
  });
});

describe("safeReturnTo", () => {
  it("keeps paths on this site and sends everything else home", () => {
    for (const path of ["/", "/acme/shop", "/acme/shop/abc?x=1#y", "/a/b%2F%2Fc"]) {
      expect(safeReturnTo(path), path).toBe(path);
    }
    for (const bad of [
      null,
      undefined,
      "",
      "acme/shop",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      "https://evil.example/",
      "javascript:alert(1)",
      "/a\nb",
      "/a\u0000",
      `/${"a".repeat(512)}`,
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBe("/");
    }
  });
});
