import ts from "typescript";
import { describe, expect, it } from "vitest";
import { letValues } from "./lets.js";

/** One file's `let url` declaration, its `fetch(url)` reads, and a checker-backed `refersTo`. */
function compile(lines: string[]) {
  const name = "/x.ts";
  const text = ["declare function fetch(url: unknown): void;", ...lines].join("\n");
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost({});
  host.getSourceFile = (n) => (n === name ? file : undefined);
  host.fileExists = (n) => n === name;
  host.readFile = (n) => (n === name ? text : undefined);
  const program = ts.createProgram([name], { noLib: true, noEmit: true }, host);
  const checker = program.getTypeChecker();

  let declaration: ts.VariableDeclaration | undefined;
  const reads: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (!declaration && ts.isVariableDeclaration(n) && n.name.getText() === "url") {
      declaration = n;
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.getText() === "fetch" &&
      n.arguments[0] &&
      ts.isIdentifier(n.arguments[0])
    ) {
      reads.push(n.arguments[0]);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (!declaration) throw new Error("no `url` declaration");
  const symbol = checker.getSymbolAtLocation(declaration.name);
  let checks = 0;
  const refersTo = (id: ts.Identifier): boolean => {
    checks++;
    return checker.getSymbolAtLocation(id) === symbol;
  };
  return { declaration, reads, refersTo, checks: () => checks };
}

/** What each `fetch(url)` read may see: the values' text joined by ` | `, or `unknown`. */
function valuesAt(lines: string[]): string[] {
  const { declaration, reads, refersTo } = compile(lines);
  return reads.map((read) => {
    const values = letValues(declaration, read, refersTo);
    return values ? values.map((v) => v.getText()).join(" | ") : "unknown";
  });
}

/** `body` inside a function with a few parameters to branch on. */
const fn = (...body: string[]): string[] => [
  "export function load(flag: boolean, other: boolean, items: string[], kind: string) {",
  ...body.map((line) => `  ${line}`),
  "}",
];

describe("letValues", () => {
  it("adds the values of writes inside a loop, switch, try, or label before the read", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "for (const item of items) url = '/loop';",
          "fetch(url);",
          "while (flag) { url = '/while'; }",
          "fetch(url);",
          "switch (kind) {",
          "  case 'x': url = '/case'; break;",
          "  default: url = '/default';",
          "}",
          "fetch(url);",
          "try { url = '/try'; } catch { url = '/catch'; } finally { url = '/finally'; }",
          "fetch(url);",
          "outer: { if (flag) break outer; url = '/label'; }",
          "fetch(url);",
        ),
      ),
    ).toEqual([
      "'/a' | '/loop'",
      "'/a' | '/loop' | '/while'",
      "'/a' | '/loop' | '/while' | '/case' | '/default'",
      "'/a' | '/loop' | '/while' | '/case' | '/default' | '/try' | '/catch' | '/finally'",
      "'/a' | '/loop' | '/while' | '/case' | '/default' | '/try' | '/catch' | '/finally' | '/label'",
    ]);
  });

  it("reads before a loop, switch, try, or label that writes see only the earlier values", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "for (const item of items) { fetch(url); }",
          "switch (kind) { case 'x': fetch(url); }",
          "try { fetch(url); } catch { fetch(url); }",
          "url = '/b';",
          "while (flag) { fetch(url); url = '/c'; }",
        ),
      ),
    ).toEqual(["'/a'", "'/a'", "'/a'", "'/a'", "unknown"]);
  });

  it("a branch ending in return, throw, break, or continue adds nothing after it", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "if (flag) { url = '/thrown'; throw new Error(); }",
          "fetch(url);",
          "if (other) { url = '/returned'; return; } else { url = '/kept'; }",
          "fetch(url);",
        ),
      ),
    ).toEqual(["'/a'", "'/kept'"]);
    expect(
      valuesAt([
        "export function each(items: string[], flag: boolean) {",
        "  for (const item of items) {",
        "    let url = '/start';",
        "    if (flag) { url = '/skipped'; continue; }",
        "    if (item) { url = '/left'; break; }",
        "    fetch(url);",
        "  }",
        "}",
      ]),
    ).toEqual(["'/start'"]);
  });

  it("a let with no initializer has only the values of writes on paths that reach the read", () => {
    expect(
      valuesAt(
        fn(
          "let url;",
          "if (flag) { url = '/b'; return; }",
          "fetch(url);",
          "if (other) url = '/c';",
          "fetch(url);",
          "url = '/d';",
          "fetch(url);",
        ),
      ),
    ).toEqual(["unknown", "'/c'", "'/d'"]);
  });

  it("follows else-if chains, with and without a final else", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "if (flag) url = '/b';",
          "else if (other) url = '/c';",
          "fetch(url);",
          "if (flag) url = '/d';",
          "else if (other) url = '/e';",
          "else url = '/f';",
          "fetch(url);",
        ),
      ),
    ).toEqual(["'/a' | '/b' | '/c'", "'/d' | '/e' | '/f'"]);
  });

  it("reads in an if's condition or branches see the values before them", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "if (fetch(url), flag) { url = '/b'; fetch(url); } else { fetch(url); url = '/c'; }",
          "fetch(url);",
        ),
      ),
    ).toEqual(["'/a'", "'/b'", "'/a'", "'/b' | '/c'"]);
  });

  it("reads a let declared in a case clause", () => {
    expect(
      valuesAt(
        fn(
          "switch (kind) {",
          "  case 'x':",
          "    let url = '/x';",
          "    if (flag) { url = '/y'; break; }",
          "    if (other) url = '/z';",
          "    fetch(url);",
          "}",
        ),
      ),
    ).toEqual(["'/x' | '/z'"]);
  });

  it("makes the let unknown when written through as, !, <T>, or satisfies", () => {
    for (const write of [
      "(url as string) = '/b';",
      "url! = '/b';",
      "(<string>url) = '/b';",
      "(url satisfies string) = '/b';",
      "[(url as string)] = ['/b'];",
    ]) {
      expect(valuesAt(fn("let url = '/a';", write, "fetch(url);")), write).toEqual(["unknown"]);
    }
  });

  it("reads a `+=` statement as a write whose value is the statement (M5C.10e)", () => {
    expect(
      valuesAt(
        fn(
          "let url = '/a';",
          "if (flag) url += '?x=1';",
          "fetch(url);",
          "if (other) { url += '&y=2'; } else { url += '&z=3'; }",
          "fetch(url);",
          "url += '?w';",
          "fetch(url);",
        ),
      ),
    ).toEqual(["'/a' | url += '?x=1'", "url += '&y=2' | url += '&z=3'", "url += '?w'"]);
  });

  it("leaves other compound writes, and a `+=` used as a value, unknown (M5C.10e)", () => {
    for (const write of [
      "url -= '/b';",
      "url ||= '/b';",
      "url ??= '/b';",
      "flag && (url += '/b');",
      "fetch(url += '/b');",
      "setTimeout(() => { url += '/b'; });",
    ]) {
      const [last] = valuesAt(fn("let url = '/a';", write, "fetch(url);")).slice(-1);
      expect(last, write).toBe("unknown");
    }
  });

  it("walks the declaring function once per declaration, not once per read", () => {
    const { declaration, reads, refersTo, checks } = compile(
      fn("let url = '/a';", "fetch(url);", "if (flag) url = '/b';", "fetch(url);", "fetch(url);"),
    );
    const [first, second, third] = reads;
    expect(letValues(declaration, first!, refersTo)?.map((v) => v.getText())).toEqual(["'/a'"]);
    const once = checks();
    expect(once).toBeGreaterThan(0);
    expect(letValues(declaration, second!, refersTo)?.map((v) => v.getText())).toEqual([
      "'/a'",
      "'/b'",
    ]);
    expect(letValues(declaration, third!, refersTo)?.map((v) => v.getText())).toEqual([
      "'/a'",
      "'/b'",
    ]);
    expect(checks()).toBe(once);
  });
});
