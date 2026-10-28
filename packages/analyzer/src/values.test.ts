import ts from "typescript";
import { describe, expect, it } from "vitest";
import { redactedText } from "./values.js";

/** The first call expression in `source`, and its arguments. */
function call(source: string): ts.CallExpression {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (!found && ts.isCallExpression(n)) found = n;
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (!found) throw new Error(`no call in ${source}`);
  return found;
}

describe("redactedText", () => {
  // [source, which arguments are the URL, expected]
  const cases: [string, number[], string][] = [
    ["fetch(url)", [0], "fetch(url)"],
    ['fetch("/api/teams")', [0], 'fetch("/api/teams")'],
    [
      'fetch(url, { headers: { Authorization: "Bearer s3cret" } })',
      [0],
      'fetch(url, { headers: { Authorization: "…" } })',
    ],
    [
      'fetch(u, { headers: { "x-api-key": "k3y" } })',
      [0],
      'fetch(u, { headers: { "x-api-key": "…" } })',
    ],
    [
      'fetch(u, { method: "POST", body: "{\\"a\\":1}" })',
      [0],
      'fetch(u, { method: "POST", body: "…" })',
    ],
    ["fetch(`${base}/v2/items?key=k3y&p=${n}&sig=s1g`)", [0], "fetch(`${base}/v2/items?…${n}…`)"],
    ['fetch(base + "/x?token=t0k" + "&more")', [0], 'fetch(base + "/x?…" + "…")'],
    ["fetch(`/plain/${id}`)", [0], "fetch(`/plain/${id}`)"],
    ['call(target, "t0ken")', [0], 'call(target, "…")'],
    ['call(target, "t0ken")', [], 'call(target, "…")'],
    ['call("")', [], 'call("")'],
    ["call('single', `tpl`)", [], "call('…', `…`)"],
    // A key-value pair can start a URL's secret part without a `?` (M2 review).
    ["fetch(`${base}&token=gi_fake_tok_1`)", [0], "fetch(`${base}&…`)"],
    ['fetch(base + "&api_key=gi_fake_tok_2")', [0], 'fetch(base + "&…")'],
    ['fetch(base + "/a#frag")', [0], 'fetch(base + "/a#…")'],
    // Strings passed to a function inside the URL aren't URL text.
    ['fetch(sign("/api/x", "gi_fake_tok_3"))', [0], 'fetch(sign("…", "…"))'],
    ['fetch(new URL("/api/x", base))', [0], 'fetch(new URL("/api/x", base))'],
  ];
  it.each(cases)("%s", (source, urlArgs, expected) => {
    const c = call(source);
    expect(
      redactedText(
        c,
        urlArgs.map((i) => c.arguments[i]!),
      ),
    ).toBe(expected);
  });

  it("collapses whitespace and cuts long text after masking", () => {
    const c = call(`fetch(${"a".repeat(130)},\n  { headers: { k: "secret" } })`);
    const text = redactedText(c, [c.arguments[0]!]);
    expect(text).toHaveLength(120);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("secret");
  });
});
