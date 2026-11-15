// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_CONFIG_BYTES,
  MAX_GLOBS,
  MAX_RULES,
  parseRulesConfig,
  type ConfigIssue,
  type RulesConfig,
} from "./config.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/shop-demo.gitinside.yml",
);

const ok = (text: string): RulesConfig => {
  const result = parseRulesConfig(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
};
const issues = (text: string): ConfigIssue[] => {
  const result = parseRulesConfig(text);
  if (result.ok) throw new Error("expected the config to be refused");
  return result.issues;
};

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

describe("parseRulesConfig", () => {
  it("reads the shop-demo fixture: layers sorted, rules in order, IDs and levels filled in", () => {
    const config = ok(readFileSync(FIXTURE, "utf8"));
    expect(config.layers.map((l) => l.name)).toEqual(["api", "billing", "routes", "web"]);
    expect(config.layers[0]?.services.map((g) => g.source)).toEqual(["@shop/api"]);
    expect(config.layers[1]?.paths.map((g) => g.source)).toEqual(["apps/api/src/billing/**"]);
    expect(
      config.rules.map((r) => ({
        ...r,
        ...("datastore" in r ? { datastore: r.datastore.source } : {}),
        ...("allow" in r ? { allow: r.allow.map((g) => g.source) } : {}),
      })),
    ).toEqual([
      {
        id: "web-independent-of-api",
        level: "error",
        type: "forbid-dependency",
        from: "web",
        to: "api",
      },
      {
        id: "routes-skip-billing",
        level: "error",
        type: "forbid-dependency",
        from: "routes",
        to: "billing",
        edges: ["calls", "imports"],
      },
      { id: "no-service-cycles-3", level: "error", type: "no-service-cycles" },
      {
        id: "only-api-touches-postgres",
        level: "error",
        type: "datastore-access",
        datastore: "postgres",
        only: ["api"],
      },
      { id: "known-hosts", level: "warning", type: "no-new-hosts", allow: ["*.stripe.com"] },
    ]);
  });

  it("accepts a file with no layers and no rules", () => {
    expect(ok("version: 1\nrules: []\n")).toEqual({ version: 1, layers: [], rules: [] });
  });

  it("names unknown keys with their line, at the top and inside a rule", () => {
    expect(
      issues(
        lines(
          "version: 1",
          "rule: []",
          "rules:",
          "  - type: no-service-cycles",
          "    severity: error",
        ),
      ),
    ).toEqual([
      { path: "", line: 1, message: "unknown key: `rule`" },
      { path: "rules.0", line: 4, message: "unknown key: `severity`" },
    ]);
  });

  it("says which types exist for an unknown rule type", () => {
    expect(issues(lines("version: 1", "rules:", "  - type: no-cycles"))).toEqual([
      {
        path: "rules.0.type",
        line: 3,
        message:
          "`type` must be one of `forbid-dependency`, `no-service-cycles`, `datastore-access`, `no-new-hosts`",
      },
    ]);
  });

  it("refuses another version rather than guessing", () => {
    expect(issues(lines("version: 2", "rules: []"))).toEqual([
      { path: "version", line: 1, message: "`version` must be 1" },
    ]);
  });

  it("refuses a bad glob, saying why, at its line", () => {
    expect(
      issues(
        lines(
          "version: 1",
          "layers:",
          "  web:",
          "    paths: [apps/web/**, 'apps/{a,b}/**']",
          "rules: []",
        ),
      ),
    ).toEqual([
      {
        path: "layers.web.paths.1",
        line: 4,
        message: "bad glob `apps/{a,b}/**`: braces (`{a,b}`) aren't supported",
      },
    ]);
  });

  it("refuses rules naming layers that don't exist, and a rule from a layer to itself", () => {
    expect(
      issues(
        lines(
          "version: 1",
          "layers:",
          "  web: { services: [web] }",
          "rules:",
          "  - { type: forbid-dependency, from: web, to: db }",
          "  - { type: forbid-dependency, from: web, to: web }",
          "  - { type: datastore-access, datastore: postgres, only: [api] }",
        ),
      ),
    ).toEqual([
      { path: "rules.0.to", line: 5, message: "no layer named `db` under `layers`" },
      { path: "rules.1.to", line: 6, message: "`from` and `to` name the same layer" },
      { path: "rules.2.only.0", line: 7, message: "no layer named `api` under `layers`" },
    ]);
  });

  it("refuses two rules with one ID, including a written ID equal to a filled-in one", () => {
    expect(
      issues(
        lines(
          "version: 1",
          "rules:",
          "  - { type: no-service-cycles }",
          "  - { id: no-service-cycles-1, type: no-service-cycles }",
        ),
      ),
    ).toEqual([
      { path: "rules.1.id", line: 4, message: "two rules are named `no-service-cycles-1`" },
    ]);
  });

  it("refuses a layer with neither services nor paths", () => {
    expect(issues(lines("version: 1", "layers:", "  web: {}", "rules: []"))).toEqual([
      { path: "layers.web", line: 3, message: "a layer needs `services`, `paths`, or both" },
    ]);
  });

  it("refuses a file over 64 KiB before parsing it", () => {
    const text = `version: 1\nrules: []\n# ${"x".repeat(MAX_CONFIG_BYTES)}\n`;
    expect(issues(text)).toEqual([
      { path: "", message: `the file is ${text.length} bytes; the limit is ${MAX_CONFIG_BYTES}` },
    ]);
  });

  it("counts the size in UTF-8 bytes, not characters", () => {
    // 22,000 three-byte characters: 66,000 bytes, though only 22,000 characters.
    const text = `version: 1\nrules: []\n# ${"€".repeat(22_000)}\n`;
    expect(text.length).toBeLessThan(MAX_CONFIG_BYTES);
    expect(issues(text)[0]?.message).toMatch(/^the file is 66\d{3} bytes/);
    // 16,000 four-byte characters (two UTF-16 units each): 64,000 bytes, under the limit.
    expect(ok(`version: 1\nrules: []\n# ${"😀".repeat(16_000)}\n`).rules).toEqual([]);
  });

  it(`refuses more than ${MAX_RULES} rules and more than ${MAX_GLOBS} globs in a list`, () => {
    const rules = (n: number): string =>
      lines(
        "version: 1",
        "rules:",
        ...Array.from({ length: n }, (_, i) => `  - { id: r${i}, type: no-service-cycles }`),
      );
    expect(ok(rules(MAX_RULES)).rules).toHaveLength(MAX_RULES);
    expect(issues(rules(MAX_RULES + 1))).toEqual([
      { path: "rules", line: 3, message: `Array must contain at most ${MAX_RULES} element(s)` },
    ]);
    const globs = Array.from({ length: MAX_GLOBS + 1 }, (_, i) => `s${i}`).join(", ");
    expect(
      issues(lines("version: 1", "layers:", `  web: { services: [${globs}] }`, "rules: []")),
    ).toEqual([
      {
        path: "layers.web.services",
        line: 3,
        message: `Array must contain at most ${MAX_GLOBS} element(s)`,
      },
    ]);
  });

  it("refuses anchors and aliases, which can multiply a small file into a huge one", () => {
    expect(
      issues(
        lines("version: 1", "layers:", "  web: &w { services: [web] }", "  app: *w", "rules: []"),
      ),
    ).toEqual([{ path: "", line: 4, message: "anchors and aliases (`&`, `*`) aren't allowed" }]);
  });

  it("reports YAML syntax errors and duplicate keys with their line", () => {
    expect(issues(lines("version: 1", "rules: [", "  - x"))[0]).toMatchObject({
      path: "",
      message: expect.stringMatching(/^YAML: /),
    });
    expect(issues(lines("version: 1", "version: 1", "rules: []"))).toEqual([
      { path: "", line: 2, message: expect.stringMatching(/^YAML: Map keys must be unique/) },
    ]);
  });

  it("refuses a file that isn't a mapping, and an empty one", () => {
    expect(issues("just text\n")).toEqual([
      { path: "", line: 1, message: "Expected object, received string" },
    ]);
    expect(issues("")).toEqual([{ path: "", message: "Expected object, received null" }]);
  });

  it("reads YAML tags as data: a `!!js/function` tag is an error, never code", () => {
    const result = parseRulesConfig(
      lines("version: 1", "rules:", "  - !!js/function 'function () { return 1 }'"),
    );
    expect(result.ok).toBe(false);
  });

  it("lists the same issues in the same order for the same file", () => {
    const text = lines(
      "version: 1",
      "layers: { b: { paths: ['[x]'] }, a: { paths: ['{y}'] } }",
      "rules: [{ type: forbid-dependency, from: c, to: d }]",
    );
    expect(issues(text)).toEqual(issues(text));
    expect(issues(text).map((i) => i.path)).toEqual([
      "layers.a.paths.0",
      "layers.b.paths.0",
      "rules.0.from",
      "rules.0.to",
    ]);
  });
});
