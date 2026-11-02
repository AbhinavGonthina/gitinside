import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  absoluteFolder,
  globEntries,
  listingGlob,
  readdirEntries,
  repoPathOf,
  resolveRequire,
} from "./listings.js";

const FILES = [
  "src/app.ts",
  "src/routes/.hidden/x.ts",
  "src/routes/index.ts",
  "src/routes/users.ts",
  "src/routes/v1/orders.js",
  "src/routes/v1/orders.ts",
  "src/routes/admin/index.js",
];

describe("repoPathOf", () => {
  it.each([
    [absoluteFolder(""), ""],
    [absoluteFolder("src/routes"), "src/routes"],
    [`${REPO_ROOT}/src/routes/../app.ts`, "src/app.ts"],
    [`${REPO_ROOT}//src//routes/`, "src/routes"],
    [REPO_ROOT, ""],
  ])("reads %j as %j", (absolute, expected) => {
    expect(repoPathOf(absolute)).toBe(expected);
  });

  it.each(["/etc/passwd", "src/routes", `${REPO_ROOT}/..`, `${REPO_ROOT}/a/../../b`])(
    "refuses %j, which isn't inside the repo",
    (path) => {
      expect(repoPathOf(path)).toBeUndefined();
    },
  );
});

describe("readdirEntries", () => {
  it("lists files and folders directly in the folder, once each, sorted", () => {
    expect(readdirEntries("src/routes", FILES)).toEqual([
      ".hidden",
      "admin",
      "index.ts",
      "users.ts",
      "v1",
    ]);
    expect(readdirEntries("", FILES)).toEqual(["src"]);
    expect(readdirEntries("src/rout", FILES)).toEqual([]);
  });
});

describe("listingGlob", () => {
  it.each([
    ["*.ts", "users.ts", true],
    ["*.ts", "v1/users.ts", false],
    ["**/*.ts", "users.ts", true],
    ["**/*.ts", "a/b/users.ts", true],
    ["**/*.{ts,js}", "a/users.js", true],
    ["**/*.{ts,js}", "a/users.jsx", false],
    ["{a,b/c}/*.ts", "b/c/x.ts", true],
    ["v?/*.ts", "v1/orders.ts", true],
    ["v?/*.ts", "v/1.ts", false],
    ["routes.ts", "routesXts", false],
    ["a|b.ts", "a|b.ts", true],
    ["**", "a/b/c", true],
  ])("%j matches %j: %j", (pattern, path, expected) => {
    expect(listingGlob(pattern)?.(path)).toBe(expected);
  });

  it.each(["[ab].ts", "!(index).ts", "+(a|b).ts", "\\*.ts", "{a,b", "a}", "{a,{b,c}}"])(
    "refuses unsupported syntax in %j",
    (pattern) => {
      expect(listingGlob(pattern)).toBeUndefined();
    },
  );
});

describe("globEntries", () => {
  it("lists matching paths from the folder, skipping dot folders", () => {
    expect(globEntries("**/*.ts", "src/routes", FILES)).toEqual([
      "index.ts",
      "users.ts",
      "v1/orders.ts",
    ]);
    expect(globEntries("./*.ts", "src/routes", FILES)).toEqual(["index.ts", "users.ts"]);
    expect(globEntries("[x].ts", "src/routes", FILES)).toBeUndefined();
  });

  it("matches a hostile pattern from the repo in linear time", () => {
    // As a backtracking regex, each `**` is a `.*` that can end at any `a`: C(32, 10) tries.
    const name = "a".repeat(32);
    const start = performance.now();
    expect(globEntries(`${"**a".repeat(10)}b`, "src", [`src/${name}`])).toEqual([]);
    expect(globEntries(`${"*a".repeat(10)}b`, "src", [`src/${name}`])).toEqual([]);
    expect(globEntries(`${"**/".repeat(10)}b`, "src", [`src/${"a/".repeat(32)}c`])).toEqual([]);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it("refuses patterns too long or with too many brace alternatives", () => {
    expect(globEntries("{a,b}".repeat(9), "src", FILES)).toBeUndefined();
    expect(globEntries("a".repeat(1025), "src", FILES)).toBeUndefined();
    expect(globEntries("{a,b}".repeat(8), "src", FILES)).toEqual([]);
  });
});

describe("resolveRequire", () => {
  const files = new Set(FILES);
  it.each([
    ["./users", "src/routes/users.ts"],
    ["./users.ts", "src/routes/users.ts"],
    ["./admin", "src/routes/admin/index.js"],
    ["../app", "src/app.ts"],
    // Node tries `.js` before `.ts` (a `ts-node` hook adds `.ts` after it).
    [`${absoluteFolder("src/routes")}/v1/orders`, "src/routes/v1/orders.js"],
    [`${absoluteFolder("src/routes")}/v1/orders.ts`, "src/routes/v1/orders.ts"],
    [`${absoluteFolder("src")}`, undefined],
    ["express", undefined],
    ["./missing", undefined],
    ["../../../outside", undefined],
  ])("resolves %j from src/routes/index.ts to %j", (specifier, expected) => {
    expect(resolveRequire(specifier, "src/routes/index.ts", files)).toBe(expected);
  });
});
