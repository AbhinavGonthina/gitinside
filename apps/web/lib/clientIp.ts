import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Who a signed-out request counts against for rate limits (SPEC §3, docs/SECURITY.md T9,
 * ADR-0066).
 *
 * - **The address** comes from `x-real-ip`, else the first `x-forwarded-for` entry. On
 *   Vercel both are set by Vercel's edge and a client can't override them; anywhere else
 *   (local dev) they're whatever the client sent, which is fine for a dev server.
 * - **IPv6 counts per /64,** the block one household or VM is usually given, so cycling
 *   through addresses inside it doesn't buy more analyses.
 * - **Only a keyed hash is stored** (`rate_limits.key`, ADR-0057): HMAC-SHA256 with a key
 *   derived from a server secret, so the table can't be reversed into addresses by trying
 *   all 2^32 IPv4s.
 */

/** The address a request came from (IPv4, or an IPv6 /64 prefix), or `"unknown"`. */
export function clientAddress(headers: Headers): string {
  const candidate =
    headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!candidate) return "unknown";
  if (isIPv4(candidate)) return candidate;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(candidate)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (isIPv6(candidate)) return `${ipv6Groups(candidate).slice(0, 4).join(":")}::/64`;
  return "unknown";
}

/** The eight 16-bit groups of a valid IPv6 address, lowercase, without leading zeros. */
function ipv6Groups(address: string): string[] {
  const zone = address.indexOf("%");
  let text = (zone === -1 ? address : address.slice(0, zone)).toLowerCase();
  // An embedded IPv4 tail (`::1.2.3.4`) becomes its two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((g) =>
    parseInt(g, 16).toString(16),
  );
}

/**
 * The `rate_limits.key` for an address: `ip:` + HMAC-SHA256 hex. The HMAC key is derived
 * from `secret` with a fixed label, so it never equals the secret itself.
 */
export function rateLimitKey(secret: string, address: string): string {
  const key = createHmac("sha256", secret).update("gitinside rate-limit key v1").digest();
  return `ip:${createHmac("sha256", key).update(address).digest("hex")}`;
}
