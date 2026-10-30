import ts from "typescript";
import { describe, expect, it } from "vitest";
import { nodeKey } from "./calls.js";
import { bindOwners, NO_OWNERS, ownersAt, withFallback, type Owners } from "./owners.js";

const FILE = "src/app.ts";

/**
 * Walk `code` as the detectors do, with the functions whose name is in `symbols` declaring a
 * symbol node `symbol:<name>`, and return the owners at each call by callee name, with the
 * node keys of arrow functions by the name of the variable or call they're passed to.
 */
function walk(code: string, symbols: readonly string[]) {
  const sourceFile = ts.createSourceFile(FILE, code, ts.ScriptTarget.Latest, true);
  const at = new Map<string, Owners>();
  const arrows = new Map<string, string>();
  const visit = (node: ts.Node, owners: Owners): void => {
    const name =
      ts.isFunctionDeclaration(node) && node.name && symbols.includes(node.name.text)
        ? node.name.text
        : undefined;
    const current = ownersAt(FILE, node, name && `symbol:${name}`, owners);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      at.set(node.expression.text, current);
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg)) arrows.set(node.expression.text, nodeKey(FILE, arg));
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, current);
    });
  };
  visit(sourceFile, NO_OWNERS);
  const owners = (call: string): Owners => {
    const found = at.get(call);
    if (!found) throw new Error(`no call ${call}`);
    return found;
  };
  const arrow = (call: string): string => {
    const found = arrows.get(call);
    if (!found) throw new Error(`no arrow passed to ${call}`);
    return found;
  };
  return { owners, arrow };
}

describe("ownersAt + bindOwners", () => {
  const code = [
    "get(() => {",
    "  direct();",
    "  each(() => nested());",
    "  function helper() { inHelper(); }",
    "});",
    "top();",
  ].join("\n");

  it("binds a call to the innermost inline handler around it, up to the nearest symbol", () => {
    const { owners, arrow } = walk(code, ["helper"]);
    const handlers = new Map([[arrow("get"), ["route:api/GET /a", "route:api/GET /b"]]]);
    expect(bindOwners(owners("direct"), handlers)).toEqual([
      "route:api/GET /a",
      "route:api/GET /b",
    ]);
    // An arrow that isn't a handler passes its outer handler's routes on.
    expect(bindOwners(owners("nested"), handlers)).toEqual([
      "route:api/GET /a",
      "route:api/GET /b",
    ]);
    // A symbol hides the handler around it.
    expect(owners("inHelper")).toEqual({ handlers: [], ids: ["symbol:helper"] });
    expect(bindOwners(owners("inHelper"), handlers)).toEqual(["symbol:helper"]);
    expect(bindOwners(owners("top"), handlers)).toEqual([]);
  });

  it("prefers the innermost handler, and falls back to ids when none is a handler", () => {
    const { owners, arrow } = walk(code, ["helper"]);
    const both = new Map([
      [arrow("get"), ["route:outer"]],
      [arrow("each"), ["route:inner"]],
    ]);
    expect(owners("nested").handlers).toEqual([arrow("each"), arrow("get")]);
    expect(bindOwners(owners("nested"), both)).toEqual(["route:inner"]);
    expect(bindOwners(owners("nested"), new Map())).toEqual([]);
  });

  it("uses a fallback only for code that has no symbol", () => {
    const { owners, arrow } = walk(code, ["helper"]);
    const file = ["file:api/src/app.ts"];
    const handlers = new Map([[arrow("get"), ["route:r"]]]);
    expect(bindOwners(withFallback(owners("direct"), file), handlers)).toEqual(["route:r"]);
    expect(bindOwners(withFallback(owners("direct"), file), new Map())).toEqual(file);
    expect(bindOwners(withFallback(owners("inHelper"), file), new Map())).toEqual([
      "symbol:helper",
    ]);
    expect(bindOwners(withFallback(owners("top"), file), handlers)).toEqual(file);
  });

  it("lets an inline handler win over a symbol declared at the same node", () => {
    const sourceFile = ts.createSourceFile(FILE, "x(() => 1);", ts.ScriptTarget.Latest, true);
    const [statement] = sourceFile.statements;
    if (!statement || !ts.isExpressionStatement(statement)) throw new Error("no statement");
    const call = statement.expression as ts.CallExpression;
    const [fn] = call.arguments;
    if (!fn) throw new Error("no arrow");
    const owners = ownersAt(FILE, fn, "symbol:x", NO_OWNERS);
    expect(bindOwners(owners, new Map([[nodeKey(FILE, fn), ["route:r"]]]))).toEqual(["route:r"]);
    expect(bindOwners(owners, new Map())).toEqual(["symbol:x"]);
  });
});
