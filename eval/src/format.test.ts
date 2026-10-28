import { describe, expect, it } from "vitest";
import {
  compareLocations,
  EvalInputError,
  inScope,
  isRepoPath,
  isRoutePath,
  labelFileName,
  parseLabelFile,
  parseReposFile,
} from "./format.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The EVALUATION.md §1 example, plus the `scope` the finalized format requires. */
const example = {
  repo: "owner/name",
  sha: SHA,
  labeler: "claude-draft",
  reviewedBy: null,
  scope: ["."],
  edges: [
    {
      callSite: { file: "apps/web/app/blog/page.tsx", line: 9 },
      method: "GET",
      target: null,
      notes: "CMS on another host; correct answer is unresolved/external",
    },
    {
      callSite: { file: "apps/web/lib/api.ts", line: 14 },
      method: "POST",
      target: { file: "apps/api/src/routes/orders.ts", line: 42, route: "POST /api/orders" },
      notes: "wrapper placeOrder()",
    },
  ],
};

const labels = (overrides: Record<string, unknown>): string =>
  JSON.stringify({ ...example, ...overrides });

/** The issue lines of the error `fn` throws. */
function issues(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvalInputError);
    return (error as Error).message;
  }
  throw new Error("expected an EvalInputError");
}

describe("isRepoPath", () => {
  it("accepts repo-relative POSIX paths", () => {
    expect(isRepoPath("apps/web/lib/api.ts")).toBe(true);
    expect(isRepoPath("README.md")).toBe(true);
  });

  it("rejects every other spelling of a path", () => {
    for (const p of ["", "./a.ts", "/a.ts", "a\\b.ts", "a//b.ts", "a/../b.ts", "a/", "."]) {
      expect(isRepoPath(p), p).toBe(false);
    }
  });
});

describe("isRoutePath", () => {
  it("accepts the analyzer's route spelling", () => {
    for (const p of ["/", "/api/orders", "/api/users/:id", "/docs/*slug", "/v1/a.b-c_d"]) {
      expect(isRoutePath(p), p).toBe(true);
    }
  });

  it("rejects Next.js file syntax, queries, and stray slashes", () => {
    for (const p of [
      "",
      "api",
      "/api/",
      "/api//x",
      "/users/[id]",
      "/a?b=1",
      "/a#x",
      "/:",
      "/a b",
    ]) {
      expect(isRoutePath(p), p).toBe(false);
    }
  });
});

describe("parseLabelFile", () => {
  it("accepts the documented example", () => {
    const parsed = parseLabelFile("x.json", JSON.stringify(example));
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.edges[1]!.target?.route).toBe("POST /api/orders");
  });

  it("accepts ALL routes, runtime methods, and columns for same-line calls", () => {
    const parsed = parseLabelFile(
      "x.json",
      labels({
        edges: [
          { callSite: { file: "a.ts", line: 3, column: 5 }, method: "GET", target: null },
          {
            callSite: { file: "a.ts", line: 3, column: 40 },
            method: null,
            target: { file: "pages/api/x.ts", line: 1, route: "ALL /api/x" },
          },
        ],
      }),
    );
    expect(parsed.edges[1]!.method).toBeNull();
  });

  it("reports invalid JSON", () => {
    expect(issues(() => parseLabelFile("bad.json", "{"))).toMatch(
      /^bad\.json:\n {2}- invalid JSON/,
    );
  });

  it("rejects unknown keys, bad SHAs, labelers, and routes with their paths", () => {
    const message = issues(() =>
      parseLabelFile(
        "x.json",
        labels({
          sha: "abc",
          labeler: "gpt",
          extra: 1,
          edges: [
            {
              callSite: { file: "a.ts", line: 0 },
              method: "get",
              target: { file: "b.ts", line: 1, route: "/api/x" },
            },
          ],
        }),
      ),
    );
    expect(message).toContain("sha: must be a 40-character lowercase hex SHA");
    expect(message).toContain("labeler:");
    expect(message).toContain("Unrecognized key(s) in object: 'extra'");
    expect(message).toContain("edges.0.callSite.line:");
    expect(message).toContain("edges.0.method:");
    expect(message).toContain('edges.0.target.route: must be "<METHOD> <path>"');
  });

  it("rejects unknown route methods and Next.js segment syntax in routes", () => {
    for (const route of ["FETCH /a", "GET /users/[id]", "GET", "GET  /a"]) {
      const text = labels({
        edges: [
          {
            callSite: { file: "a.ts", line: 1 },
            method: "GET",
            target: { file: "b.ts", line: 1, route },
          },
        ],
      });
      expect(
        issues(() => parseLabelFile("x.json", text)),
        route,
      ).toContain("target.route");
    }
  });

  it("requires labels sorted by call site and unique", () => {
    const site = (file: string, line: number, column?: number) => ({
      callSite: { file, line, ...(column ? { column } : {}) },
      method: "GET",
      target: null,
    });
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [site("b.ts", 1), site("a.ts", 1)] }))),
    ).toContain("edges.1: label (call site + target) out of order");
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [site("a.ts", 2), site("a.ts", 1)] }))),
    ).toContain("edges.1: label (call site + target) out of order");
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [site("a.ts", 1), site("a.ts", 1)] }))),
    ).toContain("edges.1: duplicate label (call site + target)");
    expect(() =>
      parseLabelFile("x.json", labels({ edges: [site("a.ts", 1), site("a.ts", 1, 9)] })),
    ).not.toThrow();
  });

  it("allows one label per target at a call site whose URL has alternatives, sorted by target", () => {
    const at = (target: { file: string; line: number; route: string } | null) => ({
      callSite: { file: "a.ts", line: 1 },
      method: "DELETE",
      target,
    });
    const admin = { file: "r.ts", line: 9, route: "DELETE /api/posts/admin/:id" };
    const own = { file: "r.ts", line: 3, route: "DELETE /api/posts/:id" };
    const parsed = parseLabelFile("x.json", labels({ edges: [at(own), at(admin)] }));
    expect(parsed.edges.map((e) => e.target?.route ?? null)).toEqual([
      "DELETE /api/posts/:id",
      "DELETE /api/posts/admin/:id",
    ]);
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [at(admin), at(own)] }))),
    ).toContain("edges.1: label (call site + target) out of order");
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [at(own), at(null)] }))),
    ).toContain("edges.1: label (call site + target) out of order");
    expect(issues(() => parseLabelFile("x.json", labels({ edges: [at(own), at(own)] })))).toContain(
      "edges.1: duplicate label (call site + target)",
    );
  });

  it("rejects labels at one call site that scoring can't tell apart (M3 review)", () => {
    const at = (target: { file: string; line: number; route: string } | null, line = 1) => ({
      callSite: { file: "a.ts", line },
      method: "GET",
      target,
    });
    const own = { file: "r.ts", line: 3, route: "GET /api/posts/:id" };
    const same = "same route as another label at this call site";
    // Scoring ignores route lines and parameter names, so these would be one route twice.
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [at(own), at({ ...own, line: 4 })] }))),
    ).toContain(`edges.1.target: ${same}`);
    const renamed = { ...own, route: "GET /api/posts/:postId" };
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [at(own), at(renamed)] }))),
    ).toContain(`edges.1.target: ${same}`);
    // `null` says the call reaches no route, so it can't share a site with one.
    expect(
      issues(() => parseLabelFile("x.json", labels({ edges: [at(null), at(own)] }))),
    ).toContain("edges.1.target: a call site can't be labeled both `null` and a route");
    // Different sites are independent.
    expect(() =>
      parseLabelFile("x.json", labels({ edges: [at(null), at(own, 2), at(renamed, 3)] })),
    ).not.toThrow();
  });

  it("requires a sorted, non-empty scope that covers every call site", () => {
    expect(issues(() => parseLabelFile("x.json", labels({ scope: [] })))).toContain("scope:");
    expect(issues(() => parseLabelFile("x.json", labels({ scope: ["b", "a"] })))).toContain(
      "scope.1: scope entry out of order",
    );
    expect(issues(() => parseLabelFile("x.json", labels({ scope: ["apps/api"] })))).toContain(
      "edges.0.callSite.file: call site is outside the label file's scope",
    );
    expect(() => parseLabelFile("x.json", labels({ scope: ["apps/web"] }))).not.toThrow();
  });
});

describe("inScope", () => {
  it("matches whole folders, not name prefixes", () => {
    expect(inScope(["."], "x/y.ts")).toBe(true);
    expect(inScope(["apps/web"], "apps/web/a.ts")).toBe(true);
    expect(inScope(["apps/web"], "apps/web-admin/a.ts")).toBe(false);
    expect(inScope(["apps/web/a.ts"], "apps/web/a.ts")).toBe(true);
  });
});

describe("compareLocations", () => {
  it("orders by file, line, then column with a missing column first", () => {
    const sorted = [
      { file: "b.ts", line: 1 },
      { file: "a.ts", line: 2, column: 1 },
      { file: "a.ts", line: 2 },
      { file: "a.ts", line: 10 },
    ].sort(compareLocations);
    expect(sorted).toEqual([
      { file: "a.ts", line: 2 },
      { file: "a.ts", line: 2, column: 1 },
      { file: "a.ts", line: 10 },
      { file: "b.ts", line: 1 },
    ]);
  });
});

describe("parseReposFile", () => {
  const repo = {
    owner: "acme",
    name: "shop",
    url: "https://github.com/acme/shop",
    sha: SHA,
    license: "MIT",
    shape: "spa-plus-express",
    why: "React SPA calling its Express API.",
  };

  it("accepts an empty list and a valid repo", () => {
    expect(parseReposFile("repos.json", '{ "repos": [] }').repos).toEqual([]);
    expect(parseReposFile("repos.json", JSON.stringify({ repos: [repo] })).repos[0]!.shape).toBe(
      "spa-plus-express",
    );
  });

  it("rejects mismatched URLs, copyleft licenses, and unknown shapes", () => {
    const message = issues(() =>
      parseReposFile(
        "repos.json",
        JSON.stringify({
          repos: [{ ...repo, url: "https://github.com/x/y", license: "GPL-3.0", shape: "cli" }],
        }),
      ),
    );
    expect(message).toContain("repos.0.license:");
    expect(message).toContain("repos.0.shape:");
    // The URL refinement runs once the object itself parses.
    expect(
      issues(() =>
        parseReposFile(
          "repos.json",
          JSON.stringify({ repos: [{ ...repo, url: "https://github.com/x/y" }] }),
        ),
      ),
    ).toContain("repos.0.url: url must be https://github.com/<owner>/<name>");
  });

  it("requires repos sorted case-insensitively by owner/name and unique", () => {
    const other = { ...repo, owner: "Beta", url: "https://github.com/Beta/shop" };
    expect(() => parseReposFile("r", JSON.stringify({ repos: [repo, other] }))).not.toThrow();
    expect(issues(() => parseReposFile("r", JSON.stringify({ repos: [other, repo] })))).toContain(
      "repos.1: repo out of order",
    );
    expect(issues(() => parseReposFile("r", JSON.stringify({ repos: [repo, repo] })))).toContain(
      "repos.1: duplicate repo",
    );
  });
});

describe("labelFileName", () => {
  it("joins owner and name with a double underscore", () => {
    expect(labelFileName("calcom", "cal.com")).toBe("calcom__cal.com.json");
  });
});
