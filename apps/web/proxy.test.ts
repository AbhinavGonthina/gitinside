// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

function nonceOf(csp: string | null): string {
  const match = /'nonce-([^']+)'/.exec(csp ?? "");
  expect(match, csp ?? "no CSP").not.toBeNull();
  return match![1]!;
}

describe("proxy", () => {
  it("gives the response a CSP and passes the same policy to the renderer", () => {
    const response = proxy(new NextRequest("https://gitinside.example/acme/shop"));
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("upgrade-insecure-requests");
    // NextResponse.next({ request: { headers } }) forwards overridden request
    // headers to the renderer through these two response headers.
    expect(response.headers.get("x-middleware-override-headers")).toContain(
      "content-security-policy",
    );
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("uses a new nonce for every response", () => {
    const a = proxy(new NextRequest("https://gitinside.example/"));
    const b = proxy(new NextRequest("https://gitinside.example/"));
    expect(nonceOf(a.headers.get("Content-Security-Policy"))).not.toBe(
      nonceOf(b.headers.get("Content-Security-Policy")),
    );
  });

  it("doesn't upgrade requests on plain http (local next start)", () => {
    const response = proxy(new NextRequest("http://localhost:3000/"));
    expect(response.headers.get("Content-Security-Policy")).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("covers pages but not static files, the image optimizer, or the API", () => {
    const source = new RegExp(`^${config.matcher[0]!.source}$`);
    // Owners that merely start with "api" are pages too (M5 review).
    for (const path of [
      "/",
      "/acme/shop",
      "/acme/shop/abc1234",
      "/api-platform/core",
      "/apify/x",
    ]) {
      expect(source.test(path), path).toBe(true);
    }
    for (const path of [
      "/_next/static/chunks/x.js",
      "/_next/image",
      "/api/analyze",
      "/api/badge/acme/shop.svg",
      "/icon.svg",
    ]) {
      expect(source.test(path), path).toBe(false);
    }
  });
});
