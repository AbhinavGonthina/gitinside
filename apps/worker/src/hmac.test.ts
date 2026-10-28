import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_CLOCK_SKEW_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  secretsFromEnv,
  signRequest,
  verifyRequest,
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
