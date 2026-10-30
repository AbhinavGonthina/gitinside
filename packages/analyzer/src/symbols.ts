import ts from "typescript";
import { nodeId, type GraphNode } from "@gitinside/schema";
import { fileNodeId, withinService } from "./files.js";
import type { ServiceProgram } from "./program.js";
import type { WorkspacePackage } from "./workspace.js";

/** What a symbol node represents (the schema's `symbolKind`). */
export type SymbolKind = "function" | "class" | "method" | "variable";

/** A top-level declaration found in one source file. */
export interface ExtractedSymbol {
  /** Name within the file: `createOrder`, or `Class.method` for methods. */
  qualified: string;
  /** Display name: the declared name, or the method name for methods. */
  name: string;
  symbolKind: SymbolKind;
  /** Exported from the file (ESM or CommonJS). Methods inherit their class's flag. */
  exported: boolean;
  /** Qualified name of the containing class, for methods. */
  parent?: string;
  /** Arguments a call must pass (see {@link requiredParameters}), when known. */
  requiredParams?: number;
  /** The declaration node. Its span is the symbol's source location; later passes use it for calls. */
  node: ts.Node;
}

/** Strip wrappers that don't change what a value is: parentheses, `as`, `satisfies`, `!`, `<T>x`. */
export function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** `function` for function and arrow expressions, `class` for class expressions, else `variable`. */
function valueKind(expression: ts.Expression): SymbolKind {
  const e = unwrap(expression);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return "function";
  if (ts.isClassExpression(e)) return "class";
  return "variable";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
  );
}

/** The static text of a property name, or undefined for computed names (`[key]`). */
export function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isComputedPropertyName(name) ? undefined : name.text;
}

function isModuleExports(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "module" &&
    e.name.text === "exports"
  );
}

/**
 * The CommonJS export a top-level statement assigns: `""` for `module.exports = …`, `"x"` for
 * `exports.x = …` or `module.exports.x = …`, else undefined.
 */
function commonJsExport(
  statement: ts.Statement,
): { target: string; value: ts.Expression } | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const e = statement.expression;
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return undefined;
  }
  if (isModuleExports(e.left)) return { target: "", value: e.right };
  if (ts.isPropertyAccessExpression(e.left)) {
    const object = e.left.expression;
    if ((ts.isIdentifier(object) && object.text === "exports") || isModuleExports(object)) {
      return { target: e.left.name.text, value: e.right };
    }
  }
  return undefined;
}

/**
 * How many arguments a call to `fn` must pass, as TypeScript counts them: the position
 * of the last parameter without `?`, a default, or `...`. A `this` parameter isn't one.
 */
export function requiredParameters(fn: ts.SignatureDeclaration): number {
  const positional = fn.parameters.filter(
    (p) => !(ts.isIdentifier(p.name) && p.name.text === "this"),
  );
  let required = 0;
  positional.forEach((p, i) => {
    if (!p.questionToken && !p.initializer && !p.dotDotDotToken) required = i + 1;
  });
  return required;
}

/**
 * The required argument count of a function, method, arrow, or class value (its own
 * constructor's; none and no `extends` means 0), else undefined: other values, a class
 * with several constructor signatures, or one that inherits its constructor.
 */
function callableParameters(value: ts.Node | undefined): number | undefined {
  if (value === undefined) return undefined;
  const node = ts.isExpression(value) ? unwrap(value) : value;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return requiredParameters(node);
  }
  if (!ts.isClassLike(node)) return undefined;
  const constructors = node.members.filter(ts.isConstructorDeclaration);
  const [only] = constructors;
  if (constructors.length > 1) return undefined;
  if (only) return requiredParameters(only);
  const extendsSomething = (node.heritageClauses ?? []).some(
    (c) => c.token === ts.SyntaxKind.ExtendsKeyword,
  );
  return extendsSomething ? undefined : 0;
}

/** Identifiers bound by a declaration name, including every name in a destructuring pattern. */
function boundNames(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
}

/**
 * Extract the top-level symbols of one source file, in declaration order.
 *
 * Handles:
 * - Function declarations (including `export default function`), skipping overload
 *   signatures. An anonymous default export is named `default`.
 * - Classes (declarations and `const X = class {}`) and their methods: method declarations
 *   with a body (or `abstract`), and properties initialized with a function or arrow
 *   (`handle = () => {}`). Method IDs are `Class.method`; methods inherit the class's `exported`.
 * - Top-level `const`/`let`/`var`: a function or arrow value is a `function` symbol whether
 *   or not it's exported; any other value is a `variable` symbol only when exported.
 *   Exported destructuring patterns yield one variable per bound name.
 * - Exports: the `export` modifier, local `export { a, b as c }`, `export default x`,
 *   `export = x`, and CommonJS `module.exports = x | { … }`, `exports.x = …`,
 *   `module.exports.x = …`. Exporting an identifier marks the local declaration exported
 *   (keeping its local name); exporting an inline value creates a symbol named by its export
 *   name (a named function/class expression keeps its own name; otherwise `default` for
 *   default exports). In a `module.exports = { … }` object, function values and methods are
 *   functions, class values are classes, and other values are variables.
 * - On name collisions the first declaration wins.
 * - `requiredParams` for functions, methods, function-valued variables and properties, and
 *   classes (their constructor), in TypeScript files only: in JavaScript every parameter is
 *   optional to the checker, so a count would claim more than the code does. Overloaded
 *   functions and methods get none (callers see the overloads, not the implementation).
 *
 * Not handled: nested declarations (functions inside functions, namespaces, blocks);
 * constructors (`new X()` resolves to the class) and get/set accessors; computed or empty
 * names; types, interfaces, enums; `declare` (ambient) declarations and `.d.ts` files;
 * re-exports from other modules (`export { x } from "./x"`, which M1.8 sees as imports);
 * `exports["x"] = …`, `Object.assign(module.exports, …)`, and exports inside conditionals.
 * Export detection is syntactic, so the result depends only on this file's text.
 */
export function extractSymbols(sourceFile: ts.SourceFile): ExtractedSymbol[] {
  if (sourceFile.isDeclarationFile) return [];

  // Pass 1: names a later statement exports by reference.
  const exportedNames = new Set<string>();
  const markIfIdentifier = (value: ts.Expression): boolean => {
    const e = unwrap(value);
    if (!ts.isIdentifier(e)) return false;
    exportedNames.add(e.text);
    return true;
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier || !clause || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        exportedNames.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement)) {
      markIfIdentifier(statement.expression);
    } else {
      const cjs = commonJsExport(statement);
      if (!cjs || markIfIdentifier(cjs.value)) continue;
      const value = unwrap(cjs.value);
      if (cjs.target !== "" || !ts.isObjectLiteralExpression(value)) continue;
      for (const property of value.properties) {
        if (ts.isShorthandPropertyAssignment(property)) exportedNames.add(property.name.text);
        else if (ts.isPropertyAssignment(property)) markIfIdentifier(property.initializer);
      }
    }
  }

  // Pass 2: declarations, in order.
  const javascript = /\.[cm]?jsx?$/.test(sourceFile.fileName);
  /** The `requiredParams` part of a symbol whose callable value is `value`. */
  const params = (value: ts.Node | undefined, overloaded = false): { requiredParams?: number } => {
    const count = javascript || overloaded ? undefined : callableParameters(value);
    return count === undefined ? {} : { requiredParams: count };
  };
  const functionNames = new Map<string, number>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      functionNames.set(name, (functionNames.get(name) ?? 0) + 1);
    }
  }
  const symbols: ExtractedSymbol[] = [];
  const seen = new Set<string>();
  const add = (symbol: ExtractedSymbol): void => {
    if (symbol.name === "" || seen.has(symbol.qualified)) return;
    seen.add(symbol.qualified);
    symbols.push(symbol);
  };
  const addClass = (
    name: string,
    declaration: ts.ClassLikeDeclaration,
    exported: boolean,
    node: ts.Node,
  ): void => {
    if (name === "" || seen.has(name)) return;
    add({ qualified: name, name, symbolKind: "class", exported, node, ...params(declaration) });
    const memberNames = new Map<string, number>();
    for (const member of declaration.members) {
      const text = ts.isMethodDeclaration(member) ? propertyName(member.name) : undefined;
      if (text !== undefined) memberNames.set(text, (memberNames.get(text) ?? 0) + 1);
    }
    for (const member of declaration.members) {
      const isMethod = ts.isMethodDeclaration(member)
        ? member.body !== undefined || hasModifier(member, ts.SyntaxKind.AbstractKeyword)
        : ts.isPropertyDeclaration(member) &&
          member.initializer !== undefined &&
          valueKind(member.initializer) === "function";
      if (!isMethod || member.name === undefined) continue;
      const memberName = propertyName(member.name);
      if (memberName === undefined) continue;
      add({
        qualified: `${name}.${memberName}`,
        name: memberName,
        symbolKind: "method",
        exported,
        parent: name,
        node: member,
        ...(ts.isMethodDeclaration(member)
          ? params(member, (memberNames.get(memberName) ?? 0) > 1)
          : params(ts.isPropertyDeclaration(member) ? member.initializer : undefined)),
      });
    }
  };
  /** A symbol for an exported inline value (`export default …`, `exports.x = …`). */
  const addValue = (name: string, value: ts.Expression, node: ts.Node): void => {
    const e = unwrap(value);
    const kind = valueKind(e);
    if (kind === "class" && ts.isClassExpression(e)) {
      addClass(e.name?.text ?? name, e, true, node);
    } else if (kind === "function" && ts.isFunctionExpression(e) && e.name) {
      const own = e.name.text;
      add({ qualified: own, name: own, symbolKind: kind, exported: true, node, ...params(e) });
    } else {
      add({ qualified: name, name, symbolKind: kind, exported: true, node, ...params(e) });
    }
  };

  for (const statement of sourceFile.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    const exportModifier = hasModifier(statement, ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.body) continue;
      const name = statement.name?.text ?? "default";
      add({
        qualified: name,
        name,
        symbolKind: "function",
        exported: exportModifier || exportedNames.has(name),
        node: statement,
        ...params(statement, (functionNames.get(name) ?? 0) > 1),
      });
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      addClass(name, statement, exportModifier || exportedNames.has(name), statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          if (!exportModifier) continue;
          for (const id of boundNames(declaration.name)) {
            add({
              qualified: id.text,
              name: id.text,
              symbolKind: "variable",
              exported: true,
              node: id.parent,
            });
          }
          continue;
        }
        const name = declaration.name.text;
        const exported = exportModifier || exportedNames.has(name);
        const init = declaration.initializer;
        const kind = init ? valueKind(init) : "variable";
        if (kind === "class" && init) {
          addClass(name, unwrap(init) as ts.ClassExpression, exported, declaration);
        } else if (kind === "function" || exported) {
          add({
            qualified: name,
            name,
            symbolKind: kind,
            exported,
            node: declaration,
            ...params(init),
          });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!ts.isIdentifier(unwrap(statement.expression))) {
        addValue("default", statement.expression, statement);
      }
    } else {
      const cjs = commonJsExport(statement);
      if (!cjs || ts.isIdentifier(unwrap(cjs.value))) continue;
      const value = unwrap(cjs.value);
      if (cjs.target !== "") {
        addValue(cjs.target, value, statement);
      } else if (!ts.isObjectLiteralExpression(value)) {
        addValue("default", value, statement);
      } else {
        for (const property of value.properties) {
          if (ts.isMethodDeclaration(property)) {
            const name = propertyName(property.name);
            if (name !== undefined) {
              add({
                qualified: name,
                name,
                symbolKind: "function",
                exported: true,
                node: property,
                ...params(property),
              });
            }
          } else if (ts.isPropertyAssignment(property)) {
            const name = propertyName(property.name);
            if (name !== undefined && !ts.isIdentifier(unwrap(property.initializer))) {
              addValue(name, property.initializer, property);
            }
          }
        }
      }
    }
  }
  return symbols;
}

/** The node ID of a symbol: `symbol:<service>/<service-relative path>#<qualified name>`. */
export function symbolNodeId(service: WorkspacePackage, path: string, qualified: string): string {
  return nodeId("symbol", service.key, `${withinService(service, path)}#${qualified}`);
}

/**
 * Build `symbol` nodes for every source file in each service's program (see
 * {@link extractSymbols} for what counts as a symbol). A symbol's parent is its file node,
 * or its class symbol for methods. `source` spans the declaration, starting after any JSDoc.
 */
export function buildSymbolNodes(programs: readonly ServiceProgram[]): GraphNode[] {
  return programs.flatMap((sp) => collectSymbolNodes(sp));
}

/**
 * The `symbol` nodes of one service's root files, in file and declaration order (see
 * {@link buildSymbolNodes}). They are the service's symbol facts: plain data, and a function
 * of its files' text only.
 */
export function collectSymbolNodes(sp: ServiceProgram): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const file of sp.rootFiles) {
    const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
    if (!sourceFile) continue;
    for (const symbol of extractSymbols(sourceFile)) {
      const start = sourceFile.getLineAndCharacterOfPosition(symbol.node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(symbol.node.getEnd());
      nodes.push({
        id: symbolNodeId(sp.service, file, symbol.qualified),
        kind: "symbol",
        label: symbol.name,
        parentId:
          symbol.parent === undefined
            ? fileNodeId(sp.service, file)
            : symbolNodeId(sp.service, file, symbol.parent),
        symbolKind: symbol.symbolKind,
        exported: symbol.exported,
        ...(symbol.requiredParams === undefined ? {} : { requiredParams: symbol.requiredParams }),
        source: {
          file,
          line: start.line + 1,
          column: start.character + 1,
          endLine: end.line + 1,
        },
      });
    }
  }
  return nodes;
}
