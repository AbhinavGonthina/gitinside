import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoutePath, alignSegments, ALIGN, type UrlSegment } from "@gitinside/schema";
import { formatProxyPath } from "./devProxy.js";
import {
  parsePattern,
  readNextConfig,
  readNextConfigs,
  rewriteRequest,
  type NextConfig,
  type NextRewrite,
  type PatternSegment,
} from "./nextConfig.js";
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

const showPattern = (p: readonly PatternSegment[] | undefined): string =>
  p === undefined
    ? "?"
    : "/" + p.map((s) => (s.kind === "literal" ? s.text : `:${s.name}${s.modifier}`)).join("/");

function showRule(rule: NextRewrite): string {
  const target =
    rule.target.kind === "host"
      ? `${rule.target.scheme}://${rule.target.host}`
      : rule.target.kind === "env"
        ? `$${rule.target.name}`
        : rule.target.kind === "internal"
          ? ""
          : "?";
  const flags = `${rule.basePath ? "" : " no-base"}${rule.conditional ? " if" : ""}`;
  return `${showPattern(rule.source)} → ${target}${showPattern(rule.destination)}${flags}`;
}

/** What a config's text says, one line per rewrite. */
function read(text: string, file = "next.config.js") {
  const config = readNextConfig(file, text);
  return (
    config && {
      basePath: config.basePath.join("/"),
      beforeFiles: config.beforeFiles.map(showRule),
      afterFiles: config.afterFiles.map(showRule),
      fallback: config.fallback.map(showRule),
    }
  );
}

describe("parsePattern", () => {
  it("reads literals and named params, modifiers only at the end", () => {
    expect(showPattern(parsePattern("/api/:path*"))).toBe("/api/:path*");
    expect(showPattern(parsePattern("/blog/:slug/comments"))).toBe("/blog/:slug/comments");
    expect(showPattern(parsePattern("/:lang?"))).toBe("/:lang?");
    expect(showPattern(parsePattern("/"))).toBe("/");
    expect(parsePattern("/:path*/edit")).toBeUndefined();
    expect(parsePattern("/post/:slug(\\d{1,})")).toBeUndefined();
    expect(parsePattern("/a-:b")).toBeUndefined();
    expect(parsePattern("/(.*)")).toBeUndefined();
    expect(parsePattern("api")).toBeUndefined();
  });
});

describe("readNextConfig", () => {
  it("reads basePath and an array of rewrites (afterFiles) from module.exports", () => {
    expect(
      read(`
        /** @type {import('next').NextConfig} */
        const nextConfig = {
          reactStrictMode: true,
          basePath: "/docs",
          async rewrites() {
            return [
              { source: "/api/:path*", destination: "http://localhost:4000/:path*" },
              { source: "/old", destination: "/new" },
            ];
          },
        };
        module.exports = nextConfig;
      `),
    ).toEqual({
      basePath: "docs",
      beforeFiles: [],
      afterFiles: ["/api/:path* → http://localhost:4000/:path*", "/old → /new"],
      fallback: [],
    });
  });

  it("reads the three phases, an arrow, env destinations, basePath: false, and conditions", () => {
    expect(
      read(
        `
        import type { NextConfig } from "next";
        const config: NextConfig = {
          rewrites: async () => ({
            beforeFiles: [{ source: "/a", destination: "/b", has: [{ type: "query", key: "x" }] }],
            afterFiles: [
              { source: "/api/:path*", destination: \`\${process.env.API_URL}/api/:path*\` },
              { source: "/s", destination: process.env.STATUS + "/s", basePath: false },
            ],
            fallback: [{ source: "/:path*", destination: "https://Legacy.Example.com:443/x/:path*?q=1" }],
          }),
        };
        export default config satisfies NextConfig;
      `,
        "next.config.ts",
      ),
    ).toEqual({
      basePath: "",
      beforeFiles: ["/a → /b if"],
      afterFiles: ["/api/:path* → $API_URL/api/:path*", "/s → $STATUS/s no-base"],
      fallback: ["/:path* → https://legacy.example.com/x/:path*"],
    });
  });

  it("looks through with… plugin wrappers and Next's phase function", () => {
    const rewrites = `rewrites() { return [{ source: "/x", destination: "/y" }]; }`;
    expect(
      read(
        `module.exports = withPlugins([withImages], withBundleAnalyzer({ basePath: "/a", ${rewrites} }));`,
      ),
    ).toMatchObject({ basePath: "a", afterFiles: ["/x → /y"] });
    expect(
      read(
        `export default (phase, { defaultConfig }) => { return { basePath: "/b", ${rewrites} }; };`,
        "next.config.mjs",
      ),
    ).toMatchObject({ basePath: "b", afterFiles: ["/x → /y"] });
    // A call that isn't a `with…` wrapper may return anything.
    expect(read(`module.exports = makeConfig({ basePath: "/a" });`)).toBeUndefined();
    expect(read(`const x = 1;`)).toBeUndefined();
  });

  it("leaves a computed basePath out and marks what can't be read", () => {
    expect(
      read(`
        const rules = [{ source: "/x", destination: "/y" }];
        module.exports = {
          basePath: process.env.BASE_PATH,
          async rewrites() {
            return { beforeFiles: [...rules, { source: "/z", destination: someUrl }], afterFiles: rules.map((r) => r) };
          },
        };
      `),
    ).toEqual({
      basePath: "",
      beforeFiles: ["? → ??", "/z → ??"],
      afterFiles: ["? → ??"],
      fallback: [],
    });
    // Rewrites built by code: one unknown entry after the file system.
    expect(
      read(`module.exports = { async rewrites() { const r = await load(); return r; } };`),
    ).toMatchObject({ beforeFiles: [], afterFiles: ["? → ??"], fallback: [] });
    expect(read(`module.exports = { basePath: "/a/" + x };`)).toMatchObject({ basePath: "" });
  });
});

/** A config with `basePath` and the given phases. */
function config(
  basePath: string,
  phases: Partial<Pick<NextConfig, "beforeFiles" | "afterFiles" | "fallback">>,
): NextConfig {
  return {
    config: "web/next.config.js",
    basePath: basePath.split("/").filter((s) => s !== ""),
    beforeFiles: [],
    afterFiles: [],
    fallback: [],
    ...phases,
  };
}

function rule(source: string, destination: string, more: Partial<NextRewrite> = {}): NextRewrite {
  const host = /^https?:\/\/([^/]+)/.exec(destination);
  return {
    text: source,
    source: parsePattern(source),
    target: host ? { kind: "host", scheme: "http", host: host[1] ?? "" } : { kind: "internal" },
    destination: parsePattern(host ? destination.slice(host[0].length) || "/" : destination),
    basePath: true,
    conditional: false,
    ...more,
  };
}

/** The app serves these paths (route syntax). */
const serves =
  (...paths: string[]) =>
  (path: readonly UrlSegment[], staticOnly: boolean): boolean =>
    paths.some((p) => {
      const segments = parseRoutePath(p);
      return (
        (!staticOnly || segments.every((s) => s.kind === "literal")) &&
        alignSegments(path, segments) !== ALIGN.FAIL
      );
    });

/** Where a request goes, as text. */
function send(c: NextConfig, path: string, served = serves()): string {
  const out = rewriteRequest(c, call(path), served);
  if (out.kind !== "rewritten") return out.kind;
  return `${out.rule.text} ⇒ ${out.segments ? formatProxyPath(out.segments) : "?"}`;
}

describe("rewriteRequest", () => {
  it("fills the destination from the source's params, holes included", () => {
    const c = config("", { afterFiles: [rule("/api/:path*", "http://localhost:4000/v1/:path*")] });
    expect(send(c, "/api/users/{}")).toBe("/api/:path* ⇒ /v1/users/{}");
    expect(send(c, "/api")).toBe("/api/:path* ⇒ /v1");
    expect(send(c, "/other")).toBe("none");
    const one = config("", { afterFiles: [rule("/u/:id", "/users/:id/profile")] });
    expect(send(one, "/u/{}")).toBe("/u/:id ⇒ /users/{}/profile");
    expect(send(one, "/u/1/2")).toBe("none");
    expect(send(one, "/u")).toBe("none");
  });

  it("puts basePath in front of the source and an internal destination, unless basePath: false", () => {
    const c = config("/shop", {
      afterFiles: [
        rule("/old", "/new"),
        rule("/status", "https://status.example.com/", { basePath: false }),
      ],
    });
    expect(send(c, "/shop/old")).toBe("/old ⇒ /shop/new");
    expect(send(c, "/old")).toBe("none");
    expect(send(c, "/status")).toBe("/status ⇒ /");
    expect(send(c, "/shop/status")).toBe("none");
  });

  it("follows Next's order: beforeFiles, static files, afterFiles, dynamic routes, fallback", () => {
    const c = config("", {
      beforeFiles: [rule("/items", "/catalog")],
      afterFiles: [rule("/api/:path*", "http://localhost:4000/:path*")],
      fallback: [rule("/:path*", "http://localhost:5000/:path*")],
    });
    const served = serves("/items", "/api/health", "/api/users/:id", "/blog/:slug");
    // beforeFiles wins over the static route it shadows.
    expect(send(c, "/items", served)).toBe("/items ⇒ /catalog");
    // A static route beats afterFiles; afterFiles beats a dynamic route.
    expect(send(c, "/api/health", served)).toBe("none");
    expect(send(c, "/api/users/{}", served)).toBe("/api/:path* ⇒ /users/{}");
    // A dynamic route beats fallback.
    expect(send(c, "/blog/{}", served)).toBe("none");
    expect(send(c, "/anything/else", served)).toBe("/:path* ⇒ /anything/else");
  });

  it("is undecided when a hole, a condition, or an unread entry hides which entry takes it", () => {
    expect(send(config("", { afterFiles: [rule("/api/x", "/y")] }), "/api/x{}")).toBe("undecided");
    // A pure hole never spells a literal, as in the route matcher.
    expect(send(config("", { afterFiles: [rule("/api/x", "/y")] }), "/api/{}")).toBe("none");
    expect(send(config("", { afterFiles: [rule("/api/x", "/y")] }), "/{}/x")).toBe("none");
    expect(
      send(
        config("", { afterFiles: [rule("/a", "/b", { conditional: true }), rule("/a", "/c")] }),
        "/a",
      ),
    ).toBe("undecided");
    const unread = rule("/a", "/b", { source: undefined, text: undefined });
    expect(send(config("", { afterFiles: [unread, rule("/a", "/c")] }), "/a")).toBe("undecided");
    // An entry that can't take the path doesn't hide the next one.
    expect(send(config("", { afterFiles: [rule("/z", "/b"), rule("/a", "/c")] }), "/a")).toBe(
      "/a ⇒ /c",
    );
  });

  it("has no path for a destination param the source doesn't capture or can't fit", () => {
    expect(send(config("", { afterFiles: [rule("/a/:x", "/b/:y")] }), "/a/1")).toBe("/a/:x ⇒ ?");
    expect(send(config("", { afterFiles: [rule("/a/:x*", "/b/:x")] }), "/a/1/2")).toBe(
      "/a/:x* ⇒ ?",
    );
    expect(send(config("", { afterFiles: [rule("/a/:x*", "/b/:x")] }), "/a/1")).toBe(
      "/a/:x* ⇒ /b/1",
    );
    expect(send(config("", { afterFiles: [rule("/a/:x?", "/b/:x+")] }), "/a")).toBe("/a/:x? ⇒ ?");
    expect(
      send(config("", { afterFiles: [rule("/a", "/b", { destination: undefined })] }), "/a"),
    ).toBe("/a ⇒ ?");
  });
});

describe("readNextConfigs", () => {
  it("reads the first config in Next's order, only for services that depend on next", async () => {
    const root = await mkdtemp(join(tmpdir(), "gi-next-config-"));
    await mkdir(join(root, "web"));
    await mkdir(join(root, "api"));
    await writeFile(join(root, "web/next.config.js"), `module.exports = { basePath: "/js" };`);
    await writeFile(join(root, "web/next.config.ts"), `export default { basePath: "/ts" };`);
    await writeFile(join(root, "api/next.config.js"), `module.exports = { basePath: "/api" };`);
    const workspace: Workspace = {
      tools: [],
      warnings: [],
      packages: [
        { key: "api", dir: "api", name: "api", dependencies: ["express"] },
        { key: "web", dir: "web", name: "web", dependencies: ["next", "react"] },
      ],
    };
    const configs = await readNextConfigs(
      root,
      ["api/next.config.js", "web/next.config.js", "web/next.config.ts"],
      workspace,
    );
    expect(configs("web")).toMatchObject({ config: "web/next.config.js", basePath: ["js"] });
    expect(configs("api")).toBeUndefined();
  });
});
