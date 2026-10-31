// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shopDemo } from "../shopDemo.testkit.js";
import { groupWarnings, hasSourceFiles, warningCount, WARNING_TITLES } from "./warnings.js";

describe("groupWarnings", () => {
  const warnings = [
    { code: "SYNTAX_ERROR", message: "';' expected", file: "apps/web/b.ts" },
    { code: "TSCONFIG_MISSING", message: "no tsconfig.json; using defaults", file: "apps/web" },
    { code: "SYNTAX_ERROR", message: "unexpected token", file: "apps/web/a.ts" },
    { code: "NEW_IN_A_LATER_ANALYZER", message: "something" },
    { code: "SYNTAX_ERROR", message: "no file" },
  ];

  it("groups by code under a title, each group's warnings by file then message", () => {
    const groups = groupWarnings(warnings);
    expect(groups.map((g) => [g.code, g.title, g.warnings.length])).toEqual([
      ["SYNTAX_ERROR", "Files that didn't parse", 3],
      ["NEW_IN_A_LATER_ANALYZER", "NEW_IN_A_LATER_ANALYZER", 1],
      ["TSCONFIG_MISSING", "Services without a tsconfig (defaults used)", 1],
    ]);
    expect(groups[0]?.warnings.map((w) => w.file)).toEqual([
      undefined,
      "apps/web/a.ts",
      "apps/web/b.ts",
    ]);
  });

  it("keeps a code it has no title for, titled with the code (fail visibly)", () => {
    const group = groupWarnings(warnings).find((g) => g.code === "NEW_IN_A_LATER_ANALYZER");
    expect(group?.warnings).toEqual([{ code: "NEW_IN_A_LATER_ANALYZER", message: "something" }]);
  });

  it("gives the same groups in any input order, without changing the input", () => {
    const copy = structuredClone(warnings);
    const once = groupWarnings(warnings);
    expect(groupWarnings([...warnings].reverse())).toEqual(once);
    expect(warnings).toEqual(copy);
  });

  it("titles every warning code the analyzer emits", () => {
    // Read from the analyzer's source: `code: "X"` in a warning literal, or a `warn`/`skip` helper's first argument.
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../analyzer/src");
    const codes = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      for (const m of text.matchAll(/(?:\bcode: |\b(?:warn|skip)\(\s*)"([A-Z][A-Z0-9_]+)"/g)) {
        if (m[1]) codes.add(m[1]);
      }
    }
    expect(codes.size).toBeGreaterThan(25);
    expect([...codes].filter((c) => !(c in WARNING_TITLES))).toEqual([]);
  });
});

describe("hasSourceFiles", () => {
  it("is true for a graph with a source file, false for only services and config", () => {
    const graph = shopDemo();
    expect(hasSourceFiles(graph)).toBe(true);
    const bare = { ...graph, nodes: graph.nodes.filter((n) => n.kind !== "file"), edges: [] };
    expect(hasSourceFiles(bare)).toBe(false);
  });
});

describe("warningCount", () => {
  it("counts in words", () => {
    expect(warningCount(1)).toBe("1 warning");
    expect(warningCount(1204)).toBe("1,204 warnings");
  });
});
