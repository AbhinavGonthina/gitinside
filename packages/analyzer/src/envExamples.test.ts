import { describe, expect, it } from "vitest";
import { EXAMPLE_ENV_FILE, envPrefixes, urlPathPrefix } from "./envExamples.js";

describe("EXAMPLE_ENV_FILE", () => {
  it.each([
    [".env.example", true],
    [".env.sample", true],
    [".env.template", true],
    [".env.local.example", true],
    [".env.development.sample", true],
    [".env", false],
    [".env.local", false],
    [".env.development", false],
    [".env.production", false],
    [".env.example.local", false],
    ["env.example", false],
    [".envrc", false],
  ])("%s ⇒ %s", (name, expected) => {
    expect(EXAMPLE_ENV_FILE.test(name)).toBe(expected);
  });
});

describe("urlPathPrefix", () => {
  it.each([
    ["http://localhost:5000/api", ["api"]],
    ["https://api.example.com/api/v1/", ["api", "v1"]],
    ["HTTP://localhost:5000/api", ["api"]],
    ["  http://localhost:5000/api  ", ["api"]],
    ["/api", ["api"]],
    ["http://localhost:5000", []],
    ["http://localhost:5000/", []],
    ["http://user:pass@localhost/api?token=x#frag", ["api"]],
    ["http://localhost/v1_1/a.b~c-d", ["v1_1", "a.b~c-d"]],
  ])("%s ⇒ %j", (value, expected) => {
    expect(urlPathPrefix(value)).toEqual(expected);
  });

  it.each([
    ["localhost:5000/api"],
    ["//localhost/api"],
    ["ftp://host/api"],
    ["postgres://u:p@db:5432/app"],
    ["api"],
    [""],
    ["http://localhost/${PREFIX}/api"],
    ["http://localhost/a%20b"],
    ["http://localhost/a/../b"],
    ["http://localhost/./a"],
    ["http://localhost/a/b/c/d/e"],
    [`https://hooks.example.com/services/${"x".repeat(65)}`],
  ])("%s ⇒ no path", (value) => {
    expect(urlPathPrefix(value)).toBeUndefined();
  });

  it("keeps up to four segments of 64 characters", () => {
    expect(urlPathPrefix(`/a/b/c/${"d".repeat(64)}`)).toEqual(["a", "b", "c", "d".repeat(64)]);
  });
});

describe("envPrefixes", () => {
  const prefixes = envPrefixes([
    { file: ".env.example", text: "API_URL=http://localhost:4000/root\nSHARED_API_URL=/shared" },
    {
      file: "client/.env.example",
      text: "# copy to .env\nVITE_SERVER_BASE_URL=http://localhost:5000/api\nAPI_URL=http://localhost:5000\nTOKEN_API_URL='http://h/${X}'",
    },
    { file: "admin/.env.example", text: "VITE_API_URL=http://localhost:5000/api" },
    { file: "admin/.env.sample", text: "VITE_API_URL=http://localhost:5000/admin" },
    { file: "twice/.env.example", text: "VITE_API_URL=/a\nVITE_API_URL=/b" },
    { file: "same/.env.example", text: "VITE_API_URL=/a" },
    { file: "same/.env.sample", text: 'VITE_API_URL="http://localhost:1/a"' },
  ]);

  it("reads the nearest folder's example value above the calling file", () => {
    expect(prefixes("VITE_SERVER_BASE_URL", "client/src/app/api.ts")).toEqual(["api"]);
    expect(prefixes("VITE_SERVER_BASE_URL", "client/api.ts")).toEqual(["api"]);
    expect(prefixes("SHARED_API_URL", "client/src/api.ts")).toEqual(["shared"]);
    expect(prefixes("API_URL", "server/src/api.ts")).toEqual(["root"]);
    expect(prefixes("API_URL", "api.ts")).toEqual(["root"]);
  });

  it("lets the nearest folder decide, even when it gives no path", () => {
    expect(prefixes("API_URL", "client/src/api.ts")).toBeUndefined();
    expect(prefixes("TOKEN_API_URL", "client/src/api.ts")).toBeUndefined();
  });

  it("gives nothing for a key outside the file's folders or with differing paths", () => {
    expect(prefixes("VITE_SERVER_BASE_URL", "server/src/api.ts")).toBeUndefined();
    expect(prefixes("VITE_SERVER_BASE_URL", "clientele/api.ts")).toBeUndefined();
    expect(prefixes("VITE_API_URL", "admin/src/api.ts")).toBeUndefined();
    expect(prefixes("VITE_API_URL", "twice/src/api.ts")).toBeUndefined();
    expect(prefixes("VITE_API_URL", "same/src/api.ts")).toEqual(["a"]);
  });
});
