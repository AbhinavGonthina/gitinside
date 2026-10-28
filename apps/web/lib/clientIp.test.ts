// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clientAddress, rateLimitKey } from "./clientIp";

const from = (headers: Record<string, string>) => clientAddress(new Headers(headers));

describe("clientAddress", () => {
  it("prefers x-real-ip, then the first x-forwarded-for entry", () => {
    expect(from({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })).toBe(
      "203.0.113.7",
    );
    expect(from({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" })).toBe("198.51.100.1");
  });

  it("is unknown without a valid address", () => {
    expect(from({})).toBe("unknown");
    expect(from({ "x-real-ip": "not-an-ip" })).toBe("unknown");
    expect(from({ "x-forwarded-for": "" })).toBe("unknown");
    expect(from({ "x-real-ip": "1.2.3.4.5" })).toBe("unknown");
  });

  it("counts IPv6 per /64, however the address is written", () => {
    const expected = "2001:db8:85a3:12::/64";
    for (const written of [
      "2001:db8:85a3:12::1",
      "2001:0DB8:85A3:0012:ffff:ffff:ffff:ffff",
      "2001:db8:85a3:12:0:0:0:9",
      "2001:db8:85a3:12::1.2.3.4",
      "2001:db8:85a3:12::1%eth0",
    ]) {
      expect(from({ "x-real-ip": written }), written).toBe(expected);
    }
    expect(from({ "x-real-ip": "::1" })).toBe("0:0:0:0::/64");
    expect(from({ "x-real-ip": "fe80::" })).toBe("fe80:0:0:0::/64");
  });

  it("reads IPv4-mapped IPv6 as IPv4", () => {
    expect(from({ "x-real-ip": "::ffff:192.0.2.9" })).toBe("192.0.2.9");
  });
});

describe("rateLimitKey", () => {
  it("is a stable keyed hash that doesn't contain the address", () => {
    const key = rateLimitKey("k".repeat(43), "203.0.113.7");
    expect(key).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(key).not.toContain("203.0.113.7");
    expect(rateLimitKey("k".repeat(43), "203.0.113.7")).toBe(key);
    expect(rateLimitKey("k".repeat(43), "203.0.113.8")).not.toBe(key);
    expect(rateLimitKey("j".repeat(43), "203.0.113.7")).not.toBe(key);
  });
});
