// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCsp, createNonce, SECURITY_HEADERS } from "./csp";

/** The policy as directive name → sources. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split("; ").map((d) => {
      const [name, ...sources] = d.split(" ");
      return [name!, sources];
    }),
  );
}

describe("buildCsp", () => {
  const prod = directives(buildCsp({ nonce: "abc123==", dev: false, https: true }));

  it("runs only scripts carrying this response's nonce, and never eval", () => {
    expect(prod.get("script-src")).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    for (const sources of prod.values()) {
      expect(sources).not.toContain("'unsafe-eval'");
      expect(sources).not.toContain("'unsafe-hashes'");
    }
    expect(prod.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("allows style attributes but not unnonced style tags", () => {
    expect(prod.get("style-src")).toEqual(["'self'", "'nonce-abc123=='"]);
    expect(prod.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
  });

  it("loads nothing from another origin", () => {
    for (const [name, sources] of prod) {
      for (const source of sources) {
        expect(source, `${name} ${source}`).not.toMatch(/^(https?:|\*|\/\/)|\.\w/);
      }
    }
    expect(prod.get("default-src")).toEqual(["'self'"]);
    expect(prod.get("font-src")).toEqual(["'self'"]);
    expect(prod.get("connect-src")).toEqual(["'self'"]);
  });

  it("forbids plugins, base rewriting, foreign form posts, and framing", () => {
    expect(prod.get("object-src")).toEqual(["'none'"]);
    expect(prod.get("base-uri")).toEqual(["'none'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("upgrades stray http subresources only over https", () => {
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
    const local = directives(buildCsp({ nonce: "n", dev: false, https: false }));
    expect(local.has("upgrade-insecure-requests")).toBe(false);
  });

  it("relaxes only what next dev needs", () => {
    const dev = directives(buildCsp({ nonce: "n", dev: true, https: false }));
    expect(dev.get("script-src")).toEqual([
      "'self'",
      "'nonce-n'",
      "'strict-dynamic'",
      "'unsafe-eval'",
    ]);
    expect(dev.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev.get("object-src")).toEqual(["'none'"]);
  });
});

describe("createNonce", () => {
  it("is 16 random bytes in base64, different every time", () => {
    const nonces = new Set(Array.from({ length: 100 }, createNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    }
  });
});

describe("SECURITY_HEADERS", () => {
  it("turn off sniffing and framing and keep referrers to our origin", () => {
    const headers = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
