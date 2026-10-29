import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, createNonce } from "./lib/csp";

/**
 * Runs before every page render (Next.js 16's "proxy", formerly middleware)
 * and gives the response a fresh nonce-based CSP. Next.js reads the policy
 * from the request headers while rendering and puts the nonce on its own
 * scripts, so pages must render per request; the root layout reads cookies,
 * which already makes them dynamic.
 */
export function proxy(request: NextRequest) {
  const csp = buildCsp({
    nonce: createNonce(),
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: static files and the image optimizer carry no scripts,
      // and API responses aren't HTML. Prefetches reuse the page's policy. `api/` with
      // its slash: owners like `api-platform` are pages (M5 review). The other prefixes
      // can't start a GitHub owner (no `_` or `.` in owner names).
      source: "/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
