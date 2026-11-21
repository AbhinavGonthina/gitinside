import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_SECONDS,
  PR_DIAGRAM_PURPOSE,
  PR_DIAGRAM_TOKEN_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TOKEN_REQUEST_PURPOSE,
  derivedSecret,
  secretsFromEnv,
  signPrDiagram,
  signRequest,
  verifyPrDiagram,
  verifyRequest,
  type PrDiagramClaims,
  type SignedParts,
} from "./hmac.js";

const SECRET = "s".repeat(43);
const OTHER = "o".repeat(43);
const NOW = 1_793_000_000_000;
const PARTS: SignedParts = {
  method: "POST",
  path: "/enqueue",
  body: Buffer.from('{"kind":"analyze"}'),
};

function headersFor(signed: Record<string, string>): { timestamp: unknown; signature: unknown } {
  return { timestamp: signed[TIMESTAMP_HEADER], signature: signed[SIGNATURE_HEADER] };
}

describe("signRequest", () => {
  it("signs the documented text with HMAC-SHA256", () => {
    const signed = signRequest(SECRET, PARTS, NOW + 999);
    const expected = createHmac("sha256", SECRET)
      .update('v1\n1793000000\nPOST\n/enqueue\n{"kind":"analyze"}')
      .digest("hex");
    expect(signed).toEqual({
      [TIMESTAMP_HEADER]: "1793000000",
      [SIGNATURE_HEADER]: `v1=${expected}`,
    });
  });

  it("upper-cases the method", () => {
    expect(signRequest(SECRET, { ...PARTS, method: "post" }, NOW)).toEqual(
      signRequest(SECRET, PARTS, NOW),
    );
  });
});

describe("verifyRequest", () => {
  const valid = headersFor(signRequest(SECRET, PARTS, NOW));

  it("accepts a request signed with an accepted secret", () => {
    expect(verifyRequest([SECRET], PARTS, valid, NOW)).toEqual({ ok: true });
    expect(verifyRequest([OTHER, SECRET], PARTS, valid, NOW)).toEqual({ ok: true });
  });

  it("refuses a request signed with another secret", () => {
    expect(verifyRequest([OTHER], PARTS, valid, NOW)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });

  it("binds the method, the path, and every body byte", () => {
    const changed: SignedParts[] = [
      { ...PARTS, method: "GET" },
      { ...PARTS, path: "/enqueue?x=1" },
      { ...PARTS, path: "/jobs/analyze-00000000000000000000000000000000" },
      { ...PARTS, body: Buffer.from('{"kind":"analyze"} ') },
      { ...PARTS, body: Buffer.alloc(0) },
    ];
    for (const parts of changed) {
      expect(verifyRequest([SECRET], parts, valid, NOW)).toEqual({
        ok: false,
        reason: "BAD_SIGNATURE",
      });
    }
  });

  it("accepts the clock window's edges and refuses past them", () => {
    const skew = MAX_CLOCK_SKEW_SECONDS * 1000;
    expect(verifyRequest([SECRET], PARTS, valid, NOW + skew)).toEqual({ ok: true });
    expect(verifyRequest([SECRET], PARTS, valid, NOW - skew)).toEqual({ ok: true });
    expect(verifyRequest([SECRET], PARTS, valid, NOW + skew + 1000)).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
    expect(verifyRequest([SECRET], PARTS, valid, NOW - skew - 1000)).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
  });

  it("accepts an older signature up to maxAgeSeconds, but never one further in the future", () => {
    const day = { maxAgeSeconds: 24 * 60 * 60 };
    const skew = MAX_CLOCK_SKEW_SECONDS * 1000;
    expect(verifyRequest([SECRET], PARTS, valid, NOW + 86_400_000, day)).toEqual({ ok: true });
    expect(verifyRequest([SECRET], PARTS, valid, NOW + 86_401_000, day)).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
    expect(verifyRequest([SECRET], PARTS, valid, NOW - skew - 1000, day)).toEqual({
      ok: false,
      reason: "STALE_TIMESTAMP",
    });
  });

  it("refuses missing headers", () => {
    expect(
      verifyRequest([SECRET], PARTS, { timestamp: undefined, signature: valid.signature }, NOW),
    ).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    expect(
      verifyRequest([SECRET], PARTS, { timestamp: valid.timestamp, signature: undefined }, NOW),
    ).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
  });

  it("refuses malformed timestamps", () => {
    for (const timestamp of [
      "",
      "-1",
      "1.5",
      "1e9",
      " 1793000000",
      "1".repeat(13),
      ["1793000000"],
    ]) {
      expect(verifyRequest([SECRET], PARTS, { ...valid, timestamp }, NOW)).toEqual({
        ok: false,
        reason: "BAD_TIMESTAMP",
      });
    }
  });

  it("refuses malformed signatures", () => {
    const hex = (valid.signature as string).slice(3);
    for (const signature of [
      "",
      hex,
      `v2=${hex}`,
      `v1=${hex.toUpperCase()}`,
      `v1=${hex.slice(2)}`,
      `v1=${hex}00`,
      [valid.signature],
    ]) {
      expect(verifyRequest([SECRET], PARTS, { ...valid, signature }, NOW)).toEqual({
        ok: false,
        reason: "BAD_SIGNATURE",
      });
    }
  });
});

describe("derivedSecret", () => {
  it("is HKDF-SHA256 of the secret with no salt and the purpose as info (RFC 5869)", () => {
    // One output block: PRK = HMAC(zero salt, secret), OKM = HMAC(PRK, info || 0x01).
    const prk = createHmac("sha256", Buffer.alloc(32)).update(SECRET).digest();
    const okm = createHmac("sha256", prk)
      .update(TOKEN_REQUEST_PURPOSE)
      .update(Buffer.from([1]))
      .digest();
    expect(derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE)).toBe(okm.toString("base64url"));
  });

  it("gives each purpose and secret its own key, long enough to sign with", () => {
    const key = derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE);
    expect(key).toHaveLength(43);
    expect(key).not.toBe(SECRET);
    expect(derivedSecret(SECRET, "gitinside/v1/other")).not.toBe(key);
    expect(derivedSecret(OTHER, TOKEN_REQUEST_PURPOSE)).not.toBe(key);
    // A signature made with the secret itself doesn't verify under the derived key.
    const signed = headersFor(signRequest(SECRET, PARTS, NOW));
    expect(verifyRequest([key], PARTS, signed, NOW)).toEqual({
      ok: false,
      reason: "BAD_SIGNATURE",
    });
  });
});

describe("secretsFromEnv", () => {
  it("reads the current secret, then the previous one when set", () => {
    expect(secretsFromEnv({ ENQUEUE_HMAC_SECRET: SECRET })).toEqual([SECRET]);
    expect(
      secretsFromEnv({ ENQUEUE_HMAC_SECRET: SECRET, ENQUEUE_HMAC_SECRET_PREVIOUS: "" }),
    ).toEqual([SECRET]);
    expect(
      secretsFromEnv({ ENQUEUE_HMAC_SECRET: SECRET, ENQUEUE_HMAC_SECRET_PREVIOUS: OTHER }),
    ).toEqual([SECRET, OTHER]);
  });

  it("refuses a missing or short secret without printing it", () => {
    expect(() => secretsFromEnv({})).toThrow("ENQUEUE_HMAC_SECRET is not set");
    const short = "short-secret-value";
    expect(() => secretsFromEnv({ ENQUEUE_HMAC_SECRET: short })).toThrow(
      /^ENQUEUE_HMAC_SECRET must be at least 32 characters$/,
    );
    expect(() =>
      secretsFromEnv({ ENQUEUE_HMAC_SECRET: SECRET, ENQUEUE_HMAC_SECRET_PREVIOUS: short }),
    ).toThrow(/^ENQUEUE_HMAC_SECRET_PREVIOUS must be at least 32 characters$/);
  });
});

describe("signPrDiagram and verifyPrDiagram (M15.2b)", () => {
  const KEY = derivedSecret(SECRET, PR_DIAGRAM_PURPOSE);
  const CLAIMS: PrDiagramClaims = {
    providerRepoId: 41,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const nowS = Math.floor(NOW / 1000);

  it("signs the documented text with HMAC-SHA256, expiring a lifetime from now", () => {
    const token = signPrDiagram(KEY, CLAIMS, NOW + 999);
    const expires = nowS + PR_DIAGRAM_TOKEN_SECONDS;
    const mac = createHmac("sha256", KEY)
      .update(`v1\npr-diagram\n41\n${"a".repeat(40)}\n${"b".repeat(40)}\n${expires}`)
      .digest("hex");
    expect(token).toBe(`${expires}.${mac}`);
    expect(signPrDiagram(KEY, CLAIMS, NOW, 60)).toMatch(
      new RegExp(`^${nowS + 60}\\.[0-9a-f]{64}$`),
    );
  });

  it("accepts its own token under any accepted key, and binds the repo and both commits", () => {
    const token = signPrDiagram(KEY, CLAIMS, NOW);
    const other = derivedSecret(OTHER, PR_DIAGRAM_PURPOSE);
    expect(verifyPrDiagram([KEY], CLAIMS, token, NOW)).toBe(true);
    expect(verifyPrDiagram([other, KEY], CLAIMS, token, NOW)).toBe(true);
    expect(verifyPrDiagram([other], CLAIMS, token, NOW)).toBe(false);
    // The shared secret itself, or another purpose's key, never verifies.
    expect(verifyPrDiagram([SECRET], CLAIMS, token, NOW)).toBe(false);
    expect(
      verifyPrDiagram([derivedSecret(SECRET, TOKEN_REQUEST_PURPOSE)], CLAIMS, token, NOW),
    ).toBe(false);
    for (const changed of [
      { ...CLAIMS, providerRepoId: 42 },
      { ...CLAIMS, baseSha: "c".repeat(40) },
      { ...CLAIMS, headSha: "c".repeat(40) },
      { ...CLAIMS, baseSha: CLAIMS.headSha, headSha: CLAIMS.baseSha },
    ]) {
      expect(verifyPrDiagram([KEY], changed, token, NOW), JSON.stringify(changed)).toBe(false);
    }
    // The expiry is signed: moving it breaks the token.
    const [expires, mac] = token.split(".");
    expect(verifyPrDiagram([KEY], CLAIMS, `${Number(expires) + 1}.${mac}`, NOW)).toBe(false);
  });

  it("expires, and refuses an expiry further off than a token's lifetime", () => {
    const token = signPrDiagram(KEY, CLAIMS, NOW, 60);
    expect(verifyPrDiagram([KEY], CLAIMS, token, (nowS + 59) * 1000)).toBe(true);
    expect(verifyPrDiagram([KEY], CLAIMS, token, (nowS + 60) * 1000)).toBe(false);
    // Signed with a lifetime past the cap (or by a clock running ahead): refused.
    const far = nowS + PR_DIAGRAM_TOKEN_SECONDS + MAX_CLOCK_SKEW_SECONDS;
    const signedAt = (s: number) => signPrDiagram(KEY, CLAIMS, NOW, s - nowS);
    expect(verifyPrDiagram([KEY], CLAIMS, signedAt(far), NOW)).toBe(true);
    expect(verifyPrDiagram([KEY], CLAIMS, signedAt(far + 1), NOW)).toBe(false);
  });

  it("refuses anything not shaped like a token", () => {
    const token = signPrDiagram(KEY, CLAIMS, NOW);
    const [expires, mac = ""] = token.split(".");
    for (const bad of [
      undefined,
      null,
      42,
      ["x"],
      "",
      mac,
      `${expires}.`,
      `${expires}.${mac.toUpperCase()}`,
      `${expires}.${mac}0`,
      `${expires}.${mac.slice(1)}`,
      `+${expires}.${mac}`,
      `${expires}.${mac}\n`,
      ` ${token}`,
    ]) {
      expect(verifyPrDiagram([KEY], CLAIMS, bad, NOW), JSON.stringify(bad)).toBe(false);
    }
  });
});
