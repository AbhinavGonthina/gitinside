import { describe, expect, it } from "vitest";
import type { UrlSegment } from "@gitinside/schema";
import {
  devProxies,
  formatProxyPath,
  proxyRequest,
  readViteProxy,
  type DevProxy,
  type ProxyRule,
} from "./devProxy.js";
import type { Workspace } from "./workspace.js";

/** Call segments from text where `{}` is a hole: `/api/users/{}`. */
function call(path: string): UrlSegment[] {
  return path
    .split("/")
    .filter((s) => s !== "")
    .map((segment) =>
      segment.split("{}").flatMap((text, i): UrlSegment => {
        const out: UrlSegment = i > 0 ? [{ kind: "hole" }] : [];
        if (text !== "") out.push({ kind: "text", text });
        return out;
      }),
    );
}

/** The rules a Vite config's text gives, one line each. */
function rules(text: string, file = "vite.config.ts"): string[] | undefined {
  return readViteProxy(file, text)?.map(showRule);
}

function showRule(rule: ProxyRule): string {
  const context = rule.context ?? "?";
  const target =
    rule.target.kind === "host"
      ? `${rule.target.scheme}://${rule.target.host}${rule.target.path}`
      : "?";
  const rewrite =
    rule.rewrite === undefined
      ? ""
      : rule.rewrite === "unknown"
        ? " rewrite ?"
        : ` rewrite ${rule.rewrite.anchored ? "^" : ""}${JSON.stringify(rule.rewrite.from)}→${JSON.stringify(rule.rewrite.to)}`;
  return `${context} → ${target}${rewrite}`;
}

describe("readViteProxy", () => {
  it("reads string and object entries in order, with a prefix-stripping rewrite", () => {
    expect(
      rules(`
        import { defineConfig } from "vite";
        export default defineConfig({
          plugins: [],
          server: {
            port: 5173,
            proxy: {
              "/foo": "http://localhost:4567",
              "/api": {
                target: "http://localhost:5000",
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\\/api/, ""),
              },
              '/v2': { target: \`http://127.0.0.1:8080/v2-base\`, rewrite: p => p.replace("/v2", "/") },
            },
          },
        });
      `),
    ).toEqual([
      "/foo → http://localhost:4567",
      '/api → http://localhost:5000 rewrite ^"/api"→""',
      '/v2 → http://127.0.0.1:8080/v2-base rewrite "/v2"→"/"',
    ]);
  });

  it("reads a plain object, a function config, a config const, and module.exports", () => {
    const table = `{ server: { proxy: { "/api": "http://localhost:3000" } } }`;
    for (const text of [
      `export default ${table};`,
      `export default ${table} satisfies UserConfig;`,
      `export default defineConfig(({ mode }) => (${table}));`,
      `export default defineConfig(async () => { const x = 1; return ${table}; });`,
      `export default defineConfig(function () { return ${table}; });`,
      `const config = ${table};\nexport default config;`,
      `const server = { proxy: { "/api": "http://localhost:3000" } };\nexport default { server };`,
      `module.exports = ${table};`,
    ]) {
      expect(rules(text), text).toEqual(["/api → http://localhost:3000"]);
    }
  });

  it("reads rewrite functions with a block body, flags, and escaped characters", () => {
    expect(
      rules(`export default { server: { proxy: {
        "/a": { target: "http://localhost:1", rewrite(path) { return path.replace(/^\\/a\\/v1\\.0/g, "/b"); } },
        "/c": { target: "http://localhost:1", rewrite: function (p) { return p.replace(/\\/c-x_y~/, ""); } },
      } } };`),
    ).toEqual([
      '/a → http://localhost:1 rewrite ^"/a/v1.0"→"/b"',
      '/c → http://localhost:1 rewrite "/c-x_y~"→""',
    ]);
  });

  it("marks what it can't read as unknown instead of guessing", () => {
    expect(
      rules(`
        const target = process.env.API_TARGET;
        export default { server: { proxy: {
          "^/fallback/.*": "http://localhost:1",
          [PREFIX]: "http://localhost:1",
          ...shared,
          "/env": { target, rewrite: (path) => path.replace(/^\\/env/, "") },
          "/tpl": { target: \`http://localhost:\${port}\` },
          "/meta": { target: "http://localhost:1", rewrite: (path) => path.replace(/^\\/m.ta/, "") },
          "/case": { target: "http://localhost:1", rewrite: (path) => path.replace(/^\\/case/i, "") },
          "/dollar": { target: "http://localhost:1", rewrite: (path) => path.replace(/^\\/d/, "$&") },
          "/fn": { target: "http://localhost:1", rewrite: strip },
          "/other": { target: "http://localhost:1", rewrite: (path) => other.replace(/^\\/o/, "") },
          "/ftp": "ftp://files.example.com",
          "/bad": proxyFor("x"),
        } } };
      `),
    ).toEqual([
      "? → http://localhost:1",
      "? → http://localhost:1",
      "? → ? rewrite ?",
      '/env → ? rewrite ^"/env"→""',
      "/tpl → ?",
      "/meta → http://localhost:1 rewrite ?",
      "/case → http://localhost:1 rewrite ?",
      "/dollar → http://localhost:1 rewrite ?",
      "/fn → http://localhost:1 rewrite ?",
      "/other → http://localhost:1 rewrite ?",
      "/ftp → ?",
      "/bad → ? rewrite ?",
    ]);
  });

  it("drops credentials from a target and keeps its host, port, and path", () => {
    expect(
      rules(
        `export default { server: { proxy: { "/x": "https://user:pw@API.example.com:8443/base/" } } };`,
      ),
    ).toEqual(["/x → https://api.example.com:8443/base"]);
  });

  it("gives no rules without a proxy, and one unknown rule when the table can't be read", () => {
    expect(rules(`export default { server: { port: 3000 } };`)).toEqual([]);
    expect(rules(`export default {};`)).toEqual([]);
    expect(rules(`export default { server: { proxy: makeProxy() } };`)).toEqual([
      "? → ? rewrite ?",
    ]);
    expect(rules(`export default { server: makeServer() };`)).toEqual(["? → ? rewrite ?"]);
    expect(rules(`export default { ...base, plugins: [] };`)).toEqual(["? → ? rewrite ?"]);
    // The config itself can't be read: nothing is known.
    expect(rules(`export default makeConfig();`)).toBeUndefined();
    expect(rules(`const x = 1;`)).toBeUndefined();
    // The last `server` wins, as in JavaScript.
    expect(
      rules(`export default { server: { proxy: { "/a": "http://localhost:1" } }, server: {} };`),
    ).toEqual([]);
  });

  it("parses JavaScript configs and survives syntax errors", () => {
    expect(
      rules(
        `module.exports = { server: { proxy: { "/api": "http://localhost:1" } } };`,
        "vite.config.cjs",
      ),
    ).toEqual(["/api → http://localhost:1"]);
    expect(
      rules(`export default { server: { proxy: { "/api": "http://localhost:1" `, "vite.config.mjs"),
    ).toEqual(["/api → http://localhost:1"]);
  });
});

describe("proxyRequest", () => {
  const proxy: DevProxy = {
    config: "client/vite.config.ts",
    rules: [
      {
        context: "/auth",
        rewrite: undefined,
        target: { kind: "host", scheme: "http", host: "localhost:5000", path: "" },
      },
      {
        context: "/api",
        rewrite: { from: "/api", to: "", anchored: true },
        target: { kind: "host", scheme: "http", host: "localhost:5000", path: "" },
      },
      {
        context: "/v2",
        rewrite: { from: "/v2", to: "/", anchored: false },
        target: { kind: "host", scheme: "http", host: "localhost:1", path: "/base" },
      },
      { context: "/x", rewrite: "unknown", target: { kind: "unknown" } },
      { context: undefined, rewrite: undefined, target: { kind: "unknown" } },
      { context: "/late", rewrite: undefined, target: { kind: "unknown" } },
    ],
  };
  const sent = (path: string): string => {
    const out = proxyRequest(proxy, call(path));
    if (out.kind !== "proxied") return out.kind;
    const via = out.rule.context ?? "?";
    return out.segments ? `${via} ${formatProxyPath(out.segments)}` : `${via} ?`;
  };

  it("sends a request to the first entry whose prefix its path starts with", () => {
    expect(sent("/auth/login")).toBe("/auth /auth/login");
    // A plain string prefix, as Vite matches it.
    expect(sent("/authors")).toBe("/auth /authors");
    expect(sent("/api/users/{}")).toBe("/api /users/{}");
    expect(sent("/api")).toBe("/api /");
    expect(sent("/api{}")).toBe("/api /{}");
    expect(sent("/v2/items")).toBe("/v2 /base/items");
    expect(sent("/x/y")).toBe("/x ?");
  });

  it("is undecided when a hole hides whether the prefix matches, or an unread entry comes first", () => {
    expect(sent("/au{}")).toBe("undecided");
    // Past the unread entry (a regex key, a spread), anything is undecided.
    expect(sent("/late/1")).toBe("undecided");
    expect(sent("/elsewhere")).toBe("undecided");
  });

  it("leaves a request alone when no entry matches and none is unread", () => {
    const only: DevProxy = { config: "vite.config.ts", rules: proxy.rules.slice(0, 2) };
    expect(proxyRequest(only, call("/health")).kind).toBe("direct");
    expect(proxyRequest(only, call("/health/{}")).kind).toBe("direct");
    expect(proxyRequest(only, call("/")).kind).toBe("direct");
    // The hole could spell `api`.
    expect(proxyRequest(only, call("/{}/x")).kind).toBe("undecided");
  });

  it("applies a rewrite only where it is known to match", () => {
    const rewrite = (from: string, to: string, anchored: boolean, path: string): string => {
      const out = proxyRequest(
        {
          config: "vite.config.ts",
          rules: [{ context: "/", rewrite: { from, to, anchored }, target: { kind: "unknown" } }],
        },
        call(path),
      );
      if (out.kind !== "proxied") return out.kind;
      return out.segments ? formatProxyPath(out.segments) : "?";
    };
    // Anchored: the start, or nothing.
    expect(rewrite("/api", "", true, "/api/a")).toBe("/a");
    expect(rewrite("/api", "", true, "/x/api/a")).toBe("/x/api/a");
    expect(rewrite("/api", "", true, "/x{}/a")).toBe("/x{}/a");
    expect(rewrite("/api", "", true, "/{}/a")).toBe("?");
    expect(rewrite("/api/v1", "", true, "/api{}")).toBe("?");
    // Unanchored: the first occurrence, known only when it lies before any hole.
    expect(rewrite("/api", "", false, "/x/api/a")).toBe("/x/a");
    expect(rewrite("/api", "", false, "/x/y")).toBe("/x/y");
    expect(rewrite("/api", "", false, "/x/{}/a")).toBe("?");
    expect(rewrite("/api", "", false, "/x/api/{}")).toBe("/x/{}");
  });
});

describe("devProxies", () => {
  const workspace: Workspace = {
    tools: ["npm-workspaces"],
    packages: [
      { key: "root", dir: "", name: "root", dependencies: [] },
      { key: "web", dir: "apps/web", name: "web", dependencies: [] },
      { key: "cra", dir: "apps/cra", name: "cra", dependencies: [] },
    ],
    warnings: [],
  };
  const vite = (target: string) => `export default { server: { proxy: { "/api": "${target}" } } };`;
  const find = devProxies(
    [
      { file: "apps/web/vite.config.ts", text: vite("http://localhost:1") },
      // Vite loads `.js` before `.ts`.
      { file: "apps/web/vite.config.js", text: vite("http://localhost:2") },
      { file: "apps/web/package.json", text: `{ "name": "web" }` },
      {
        file: "apps/cra/package.json",
        text: `{ "proxy": "http://localhost:9000", "devDependencies": { "react-scripts": "5" } }`,
      },
      // A `proxy` field without react-scripts isn't CRA's.
      { file: "apps/other/package.json", text: `{ "proxy": "http://localhost:9000" }` },
      {
        file: "client/package.json",
        text: `{ "dependencies": { "react-scripts": "5" }, "proxy": "http://localhost:4000" }`,
      },
      { file: "client/legacy/package.json", text: `{ "name": "legacy" }` },
      { file: "vite.config.ts", text: vite("http://localhost:3") },
      { file: "broken/package.json", text: `{ "proxy": ` },
    ],
    workspace,
  );
  const at = (file: string): string => {
    const proxy = find(file);
    return proxy ? `${proxy.config} ${proxy.rules.map(showRule).join(", ")}` : "none";
  };

  it("takes the nearest folder with a Vite config or a package.json, within the file's service", () => {
    expect(at("apps/web/src/api/client.ts")).toBe(
      "apps/web/vite.config.js /api → http://localhost:2",
    );
    expect(at("apps/cra/src/App.jsx")).toBe("apps/cra/package.json / → http://localhost:9000");
    expect(at("client/src/x.js")).toBe("client/package.json / → http://localhost:4000");
    // A nearer package.json without a proxy decides: none.
    expect(at("client/legacy/x.js")).toBe("none");
    expect(at("apps/other/x.js")).toBe("none");
    expect(at("broken/x.js")).toBe("none");
    // The root's config serves the root service.
    expect(at("src/main.ts")).toBe("vite.config.ts /api → http://localhost:3");
  });

  it("never looks above the file's service", () => {
    const nested: Workspace = {
      ...workspace,
      packages: [{ key: "web", dir: "apps/web", name: "web", dependencies: [] }],
    };
    const only = devProxies([{ file: "vite.config.ts", text: vite("http://localhost:3") }], nested);
    expect(only("apps/web/src/x.ts")).toBeUndefined();
    expect(only("outside.ts")).toBeUndefined();
  });
});
