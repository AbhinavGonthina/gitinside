import { describe, expect, it } from "vitest";
import { ALIGN, alignSegments, parseRoutePath, type UrlSegment } from "./routes.js";

/** `/api/users/{}` ⇒ call segments, `{}` a hole. */
const call = (path: string): UrlSegment[] =>
  path
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (s === "{}" ? [{ kind: "hole" }] : [{ kind: "text", text: s }]));

// The grammar's full cases are tested through the analyzer's matcher (match.test.ts);
// these check the shared module on its own.
describe("route grammar", () => {
  it("parses literals, params, optional params, wildcards, and other syntax", () => {
    expect(parseRoutePath("/a/:id/:opt?/*rest/x(y)")).toEqual([
      { kind: "literal", text: "a" },
      { kind: "param", optional: false },
      { kind: "param", optional: true },
      { kind: "wildcard", min: 0 },
      { kind: "complex" },
    ]);
  });

  it("aligns calls at exact, pattern, or not at all", () => {
    expect(alignSegments(call("/api/orders/{}"), parseRoutePath("/api/orders/:id"))).toBe(
      ALIGN.EXACT,
    );
    expect(alignSegments(call("/api/orders/7"), parseRoutePath("/api/orders/:id"))).toBe(
      ALIGN.PATTERN,
    );
    expect(alignSegments(call("/api/orders"), parseRoutePath("/api/orders/:id"))).toBe(ALIGN.FAIL);
    expect(alignSegments(call("/files/a/b"), parseRoutePath("/files/*"))).toBe(ALIGN.PATTERN);
  });

  it("can keep a route with no literal from taking a wholly unknown segment (M5C.7c)", () => {
    const strict = { rootWildcardsTakeHoles: false };
    expect(alignSegments(call("/api/{}"), parseRoutePath("/*splat"))).toBe(ALIGN.PATTERN);
    expect(alignSegments(call("/api/{}"), parseRoutePath("/*splat"), strict)).toBe(ALIGN.FAIL);
    expect(alignSegments(call("/v/{}"), parseRoutePath("/:lang/*rest"), strict)).toBe(ALIGN.FAIL);
    expect(alignSegments(call("/{}"), parseRoutePath("/:p+"), strict)).toBe(ALIGN.FAIL);
    // Literals still go under it, its wildcard may take nothing, and a param takes a hole.
    expect(alignSegments(call("/api/a/b"), parseRoutePath("/*splat"), strict)).toBe(ALIGN.PATTERN);
    expect(alignSegments(call("/{}"), parseRoutePath("/:id/*rest"), strict)).toBe(ALIGN.PATTERN);
    // A catch-all under a literal still takes an unknown rest.
    expect(alignSegments(call("/api/{}/x"), parseRoutePath("/api/:p+"), strict)).toBe(
      ALIGN.PATTERN,
    );
  });
});
