// @vitest-environment node
// (Pure tokenizing; no DOM needed, and jsdom's URL rejects the file: URL below.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_LINES,
  highlightLines,
  kindOfColor,
  languageOf,
  loadSyntax,
  MAX_LINE_LENGTH,
  mergeTokens,
  syntaxReady,
  type SyntaxKind,
  type SyntaxLanguage,
  type SyntaxToken,
} from "./syntax.js";

/** Load `language`, then highlight `code`'s lines with no context. */
async function tokens(language: SyntaxLanguage, code: string, before: string[] = []) {
  expect(await loadSyntax(language)).toBe(true);
  const result = highlightLines(language, before, code.split("\n"));
  expect(result).toBeTruthy();
  return result!;
}

/** The kind of the first run whose text is exactly `text`, or "missing". */
function kindOf(rows: SyntaxToken[][], text: string): SyntaxKind | "plain" | "missing" {
  for (const row of rows) {
    // Runs merge neighbors of one kind, so look for `text` inside a run too.
    const run = row.find((r) => r.text === text) ?? row.find((r) => r.text.trim() === text);
    if (run) return run.kind ?? "plain";
  }
  for (const row of rows) {
    const run = row.find((r) => r.text.includes(text));
    if (run) return run.kind ?? "plain";
  }
  return "missing";
}

describe("loading", () => {
  const source = readFileSync(fileURLToPath(new URL("./syntax.ts", import.meta.url)), "utf8");

  it("imports Shiki only lazily, so the explorer's bundle doesn't carry it", () => {
    const staticImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*from\s+"([^"]+)"/gm)];
    for (const [, type, from] of staticImports) {
      if (from!.startsWith("shiki")) expect(type, from).toBe("type ");
    }
  });

  it("uses the JavaScript regex engine, never WebAssembly (the website's CSP)", () => {
    expect(source).toContain('import("shiki/engine/javascript")');
    expect(source).not.toMatch(/engine\/oniguruma|\.wasm|shiki\/wasm|bundle\/(full|web)|"shiki"/);
  });
});

describe("languageOf", () => {
  it.each([
    ["apps/api/src/server.ts", "typescript"],
    ["types/index.d.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["app/page.tsx", "tsx"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "jsx"],
    ["package.json", "json"],
    ["prisma/schema.prisma", "prisma"],
    ["docker-compose.yml", "yaml"],
    ["ci.YAML", "yaml"],
    ["Main.TS", "typescript"],
  ] as const)("%s is %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it.each([
    "Dockerfile",
    ".env",
    ".ts",
    "src.ts/README",
    "notes.md",
    "a.toString",
    "a.constructor",
  ])("%s is plain text", (path) => {
    expect(languageOf(path)).toBeUndefined();
  });
});

describe("mergeTokens", () => {
  it("joins neighbors of one kind and drops empty tokens", () => {
    expect(
      mergeTokens("const a = 1;", [
        { content: "const", color: "var(--syntax-keyword)" },
        { content: " a ", color: "var(--text)" },
        { content: "", color: "var(--syntax-string)" },
        { content: "= ", color: "#123456" },
        { content: "1", color: "var(--syntax-constant)" },
        { content: ";" },
      ]),
    ).toEqual([
      { text: "const", kind: "keyword" },
      { text: " a = " },
      { text: "1", kind: "constant" },
      { text: ";" },
    ]);
  });

  it("returns the line plain if the tokens don't spell it exactly", () => {
    expect(mergeTokens("abc", [{ content: "ab", color: "var(--syntax-keyword)" }])).toEqual([
      { text: "abc" },
    ]);
  });

  it("knows only its own colors", () => {
    expect(kindOfColor("var(--text-muted)")).toBe("comment");
    expect(kindOfColor("var(--syntax-type)")).toBe("type");
    expect(kindOfColor("var(--text)")).toBeUndefined();
    expect(kindOfColor("var(--syntax-nope)")).toBeUndefined();
    expect(kindOfColor(undefined)).toBeUndefined();
  });
});

describe("highlightLines", () => {
  it("waits for the language to load", async () => {
    expect(syntaxReady("jsx")).toBe(false);
    expect(highlightLines("jsx", [], ["<a />"])).toBeUndefined();
    const load = loadSyntax("jsx");
    expect(loadSyntax("jsx")).toBe(load);
    expect(await load).toBe(true);
    expect(syntaxReady("jsx")).toBe(true);
  });

  it("colors TypeScript by kind and spells every line exactly", async () => {
    const code = [
      'import { Router } from "express";',
      "// Orders API",
      "export const MAX_ITEMS = 25;",
      "export async function listOrders(limit: number): Promise<Order[]> {",
      "  const enabled = true;",
      "  return new OrderService().find(`limit=${limit}`);",
      "}",
      "",
    ];
    const rows = await tokens("typescript", code.join("\n"));
    expect(rows.map((r) => r.map((t) => t.text).join(""))).toEqual(code);
    expect(rows[7]).toEqual([]);
    expect(kindOf(rows, "import")).toBe("keyword");
    expect(kindOf(rows, '"express"')).toBe("string");
    expect(kindOf(rows, "// Orders API")).toBe("comment");
    expect(kindOf(rows, "MAX_ITEMS")).toBe("constant");
    expect(kindOf(rows, "25")).toBe("constant");
    expect(kindOf(rows, "listOrders")).toBe("function");
    expect(kindOf(rows, "Promise")).toBe("type");
    expect(kindOf(rows, "number")).toBe("type");
    expect(kindOf(rows, "true")).toBe("constant");
    expect(kindOf(rows, "new")).toBe("keyword");
    expect(kindOf(rows, "find")).toBe("function");
    // Operators and a template's interpolated expression stay plain text.
    expect(rows[4]!.find((t) => t.text.includes("="))?.kind).toBeUndefined();
    expect(rows[5]!.find((t) => t.text === "limit")?.kind).toBeUndefined();
  });

  it("reads the lines above, so a preview can start inside a comment", async () => {
    const rows = await tokens("typescript", "  still a comment\n*/\nconst a = 1;", [
      "const before = 0;",
      "/*",
    ]);
    expect(rows[0]).toEqual([{ text: "  still a comment", kind: "comment" }]);
    expect(rows[2]![0]).toEqual({ text: "const", kind: "keyword" });
    // Without the context it's code.
    const bare = highlightLines("typescript", [], ["  still a comment"]);
    expect(bare?.[0]?.some((t) => t.kind === "comment")).toBe(false);
  });

  it(`reads at most ${CONTEXT_LINES} lines above`, async () => {
    const filler = Array.from({ length: CONTEXT_LINES }, (_, i) => `const x${i} = ${i};`);
    const rows = await tokens("typescript", "  not seen as a comment", ["/*", ...filler]);
    expect(rows[0]?.some((t) => t.kind === "comment")).toBe(false);
  });

  it("leaves a minified line plain", async () => {
    const long = `const a = ${"1 + ".repeat(MAX_LINE_LENGTH / 4)}1;`;
    const rows = await tokens("javascript", `${long}\nconst b = 2;`);
    expect(rows[0]).toEqual([{ text: long }]);
    expect(rows[1]![0]).toEqual({ text: "const", kind: "keyword" });
  });

  it.each([
    [
      "tsx",
      'export default function Page() {\n  return <Layout title="Shop" />;\n}',
      [
        ["function", "keyword"],
        ["Page", "function"],
        ["Layout", "type"],
        ['"Shop"', "string"],
      ],
    ],
    [
      "javascript",
      "const app = require('express')();\napp.listen(3000);",
      [
        ["const", "keyword"],
        ["'express'", "string"],
        ["3000", "constant"],
      ],
    ],
    [
      "jsx",
      'const a = <div className="x">{n}</div>;',
      [
        ["div", "keyword"],
        ['"x"', "string"],
      ],
    ],
    [
      "json",
      '{ "name": "@shop/api", "private": true, "port": 3000 }',
      [
        ['"name"', "keyword"],
        ['"@shop/api"', "string"],
        ["true", "constant"],
        ["3000", "constant"],
      ],
    ],
    [
      "prisma",
      "model Order {\n  id    Int    @id @default(autoincrement())\n  // note\n}",
      [
        ["model", "keyword"],
        ["Order", "type"],
        ["Int", "type"],
        ["@id", "function"],
        ["// note", "comment"],
      ],
    ],
    [
      "yaml",
      "services:\n  db:\n    image: postgres:16 # pinned\n    ports: [5432]",
      [
        ["services", "keyword"],
        ["image", "keyword"],
        ["postgres:16", "string"],
        ["# pinned", "comment"],
        ["5432", "constant"],
      ],
    ],
  ] as const)("colors %s", async (language, code, expected) => {
    const rows = await tokens(language, code);
    expect(rows.map((r) => r.map((t) => t.text).join(""))).toEqual(code.split("\n"));
    for (const [text, kind] of expected) expect(kindOf(rows, text), text).toBe(kind);
  });

  it("caches by content", async () => {
    await loadSyntax("typescript");
    const a = highlightLines("typescript", ["// a"], ["const b = 1;"]);
    expect(highlightLines("typescript", ["// a"], ["const b = 1;"])).toBe(a);
    expect(highlightLines("typescript", ["/* a"], ["const b = 1;"])).not.toBe(a);
  });
});
