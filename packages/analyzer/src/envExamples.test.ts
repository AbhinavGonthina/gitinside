import { describe, expect, it } from "vitest";
import { EXAMPLE_ENV_FILE, envExamples, urlOrigin, urlPathPrefix } from "./envExamples.js";

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

describe("urlOrigin", () => {
  it.each([
    ["http://localhost:5000/api", { scheme: "http", host: "localhost:5000" }],
    ["HTTPS://API.OpenAI.com/v1", { scheme: "https", host: "api.openai.com" }],
    ["https://user:pass@api.acme.io:8443/x?k=v", { scheme: "https", host: "api.acme.io:8443" }],
    ["http://[::1]:3000/api", { scheme: "http", host: "[::1]:3000" }],
    ["https://yourls.org/api", { scheme: "https", host: "yourls.org" }],
    ["https://api.testing.dev/v1", { scheme: "https", host: "api.testing.dev" }],
  ])("%s ⇒ %j", (value, expected) => {
    expect(urlOrigin(value)).toEqual(expected);
  });

  it.each([
    ["/api"],
    ["//api.acme.io/v1"],
    ["ftp://host/api"],
    ["http://${HOST}/api"],
    [""],
    // Placeholders (M9.7g): no host anything is reached at.
    ["https://YOUR_RESOURCE.openai.azure.com/openai/v1"],
    ["https://<your-host>/v1"],
    ["https://example.com/v1"],
    ["https://api.example.org:8443/v1"],
    ["https://llm.example/v1"],
    ["http://api.test/v1"],
    ["https://your-domain.com/api"],
    ["https://yourdomain.com/api"],
    ["https://xxx.openai.azure.com"],
  ])("%s ⇒ no origin", (value) => {
    expect(urlOrigin(value)).toBeUndefined();
  });
});

describe("envExamples", () => {
  const examples = envExamples([
    { file: ".env.example", text: "API_URL=http://localhost:4000/root\nSHARED_API_URL=/shared" },
    {
      file: "client/.env.example",
      text: "# copy to .env\nVITE_SERVER_BASE_URL=http://localhost:5000/api\nAPI_URL=http://localhost:5000\nTOKEN_API_URL='http://h/${X}'\nBAD_API_URL=not a url",
    },
    { file: "admin/.env.example", text: "VITE_API_URL=http://localhost:5000/api" },
    { file: "admin/.env.sample", text: "VITE_API_URL=http://localhost:5000/admin" },
    { file: "twice/.env.example", text: "VITE_API_URL=/a\nVITE_API_URL=/b" },
    { file: "same/.env.example", text: "VITE_API_URL=/a" },
    { file: "same/.env.sample", text: 'VITE_API_URL="http://localhost:1/a"' },
    {
      file: "ports/.env.example",
      text: "VITE_API_URL=http://localhost:3000/api\nVITE_API_URL=http://localhost:5000/api",
    },
    { file: "proxy/.env.example", text: "UPSTREAM_BASE_URL=https://api.openai.com/v1" },
  ]);
  const path = (name: string, file: string) => examples(name, file)?.path;

  it("reads the nearest folder's example value above the calling file", () => {
    expect(examples("VITE_SERVER_BASE_URL", "client/src/app/api.ts")).toEqual({
      path: ["api"],
      origin: { scheme: "http", host: "localhost:5000" },
    });
    expect(path("VITE_SERVER_BASE_URL", "client/api.ts")).toEqual(["api"]);
    expect(examples("SHARED_API_URL", "client/src/api.ts")).toEqual({ path: ["shared"] });
    expect(path("API_URL", "server/src/api.ts")).toEqual(["root"]);
    expect(path("API_URL", "api.ts")).toEqual(["root"]);
    expect(examples("UPSTREAM_BASE_URL", "proxy/src/llm.ts")).toEqual({
      path: ["v1"],
      origin: { scheme: "https", host: "api.openai.com" },
    });
  });

  it("lets the nearest folder decide, even when it gives no path (ADR-0202's M9.1a3)", () => {
    // A URL with no path is an empty prefix, not "no prefix": it can replace a fallback's path.
    expect(examples("API_URL", "client/src/api.ts")).toEqual({
      path: [],
      origin: { scheme: "http", host: "localhost:5000" },
    });
    // An unusable path keeps the origin alone, and a value that isn't a URL gives nothing.
    expect(examples("TOKEN_API_URL", "client/src/api.ts")).toEqual({
      origin: { scheme: "http", host: "h" },
    });
    expect(examples("BAD_API_URL", "client/src/api.ts")).toBeUndefined();
  });

  it("gives nothing for a key outside the file's folders or with differing paths", () => {
    expect(path("VITE_SERVER_BASE_URL", "server/src/api.ts")).toBeUndefined();
    expect(path("VITE_SERVER_BASE_URL", "clientele/api.ts")).toBeUndefined();
    expect(examples("VITE_API_URL", "admin/src/api.ts")).toEqual({
      origin: { scheme: "http", host: "localhost:5000" },
    });
    expect(examples("VITE_API_URL", "twice/src/api.ts")).toBeUndefined();
    // A root-relative value has no origin, so the folder's values give none.
    expect(examples("VITE_API_URL", "same/src/api.ts")).toEqual({ path: ["a"] });
    // Different origins, one path: the path still counts.
    expect(examples("VITE_API_URL", "ports/src/api.ts")).toEqual({ path: ["api"] });
  });
});
