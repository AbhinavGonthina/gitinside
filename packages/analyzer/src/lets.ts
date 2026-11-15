/**
 * The values a `let` can hold where it is read (M5A.3h, ADR-0166): the reaching definitions of
 * a local variable, read from the syntax of one function's statements. Nothing is run, and any
 * write this can't place makes the whole value unknown.
 *
 * Handled:
 * - `let url = A;` then plain assignment statements `url = B;` in the same function, at any
 *   depth of blocks, `if`/`else`, and other statements.
 * - A later plain write replaces the earlier values (`let url = A; url = B; fetch(url)` reads
 *   only `B`); one inside an `if` adds to them; an `if` whose two branches both write replaces
 *   them; a branch that ends in `return`, `throw`, `break`, or `continue` adds nothing after it.
 * - A write inside a loop, `switch`, `try`, or labeled statement that comes before the read (and
 *   doesn't contain it) may or may not have run: its values are added to the earlier ones.
 * - `url = url + "?x"`: the right side reads the values before that write.
 * - `url += "?x";` statements (M5C.10e, ADR-0166's amendment): the value is the `+=` expression
 *   itself, whose left reads the values before it; the URL normalizer decides what it reads as
 *   (only an append inside the query, `url.ts`).
 * - A `let` with no initializer starts with no value: reading it before any write is unknown,
 *   and a path that never writes it adds nothing (it would send `undefined`).
 * - A module-level `let` with no initializer whose only write is one plain `x = value;` statement
 *   inside a nested function (M12.1b, ADR-0304: a test's `let baseUrl;` set in a `before` hook's
 *   `listen(0, () => { baseUrl = … })`): a read in another function holds that value, since
 *   before the write runs it holds only `undefined`, which adds nothing, as above.
 *
 * Not handled (unknown, so the URL gets a hole):
 * - `var`, exported `let`s, and `let`s in a `for` head.
 * - Any other write: other compound assignments (`-=`, `||=`, `??=`), `++`, a `+=` used as a
 *   value (`fetch(url += "?x")`), destructuring (`[url] = …`, `({ url } = …)`), `for (url of …)`,
 *   an assignment used as a value (`x && (url = B)`), a write through parentheses, `as`, `!`,
 *   `<T>`, or `satisfies` (`(url as string) = B`), or a write inside a nested function other
 *   than the one above: a second write anywhere, a `+=`, an initializer, a `let` inside a
 *   function, or a value that reads the `let` itself.
 * - A read in a nested function (a callback may run after any write) other than the one above,
 *   a read at the top level or inside the writing function when the write is nested, a read in
 *   the same declaration list, or in a statement that also writes it inside a loop, `switch`,
 *   `try`, or label.
 */
import ts from "typescript";

/** Statements that end the path they're on: nothing after them runs. */
function exits(statement: ts.Statement): boolean {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

/** The innermost function-like node (or the source file) whose body holds `node`. */
function scopeOf(node: ts.Node): ts.Node {
  for (let n = node.parent as ts.Node | undefined; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n) || ts.isSourceFile(n)) {
      return n;
    }
  }
  return node.getSourceFile();
}

/** True when `inner` is `outer` or inside it. */
const within = (inner: ts.Node, outer: ts.Node): boolean =>
  inner.pos >= outer.pos && inner.end <= outer.end;

/**
 * True when an identifier is written to (an assignment target, `++`/`--`, or a `for` head),
 * also through parentheses, `as`, `!`, `<T>`, `satisfies`, and destructuring patterns.
 */
function isWritten(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  for (;;) {
    const parent = node.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      return (
        parent.left === node &&
        op >= ts.SyntaxKind.FirstAssignment &&
        op <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      return (
        parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
      return parent.initializer === node;
    }
    return false;
  }
}

/** A definition: the declaration's initializer, a plain write's right side, or a `+=` itself. */
type Definition = ts.Expression;

/** A `let` whose writes are all plain statements in its own function. */
interface Writes {
  /** The function (or file) declaring it. */
  scope: ts.Node;
  /** The `let` statement. */
  statement: ts.VariableStatement;
  /** The statements around the `let`, from the block or case clause holding it. */
  statements: readonly ts.Statement[];
  /** Each `x = value;` or `x += value;` statement and its definition. */
  writes: Map<ts.Statement, Definition>;
  /** The one write inside a nested function (M12.1b): that function and the value written. */
  nested?: { scope: ts.Node; value: Definition };
}

/** Each declaration's writes, found once however many reads ask (`null`: can't be told). */
const writesCache = new WeakMap<ts.VariableDeclaration, Writes | null>();

/** The writes of a `let` (see the file comment), or `null` when one can't be placed. */
function writesOf(
  declaration: ts.VariableDeclaration,
  refersTo: (id: ts.Identifier) => boolean,
): Writes | null {
  const list = declaration.parent;
  if (!ts.isIdentifier(declaration.name)) return null;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Let) === 0) return null;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement)) return null;
  if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return null;
  const container = statement.parent;
  if (!("statements" in container)) return null;
  const statements = (container as { statements: ts.NodeArray<ts.Statement> }).statements;
  const scope = scopeOf(declaration);

  // Every write must be a plain `x = value;` statement in the declaring function, or the one
  // nested write below.
  const writes = new Map<ts.Statement, Definition>();
  const nested: { scope: ts.Node; value: Definition }[] = [];
  let unknown = false;
  const name = declaration.name.text;
  const mentions = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === name && refersTo(node)) ||
    (ts.forEachChild(node, mentions) ?? false);
  const visit = (node: ts.Node): void => {
    if (unknown) return;
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === name) {
      if (refersTo(node) && isWritten(node)) {
        const assignment = node.parent;
        const op = ts.isBinaryExpression(assignment) ? assignment.operatorToken.kind : undefined;
        const plain =
          ts.isBinaryExpression(assignment) &&
          assignment.left === node &&
          (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken) &&
          ts.isExpressionStatement(assignment.parent);
        if (!plain) {
          unknown = true;
          return;
        }
        const at = scopeOf(node);
        if (at !== scope) {
          if (op !== ts.SyntaxKind.EqualsToken) {
            unknown = true;
            return;
          }
          nested.push({ scope: at, value: assignment.right });
        } else {
          // `url += v` is `url = url + v`: the statement itself, whose left reads the values before.
          writes.set(
            assignment.parent,
            op === ts.SyntaxKind.PlusEqualsToken ? assignment : assignment.right,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  if (unknown) return null;
  if (nested.length === 0) return { scope, statement, statements, writes };
  // A nested write counts only as the module-level `let`'s one and only value (M12.1b).
  const [only] = nested;
  if (
    !only ||
    nested.length > 1 ||
    writes.size > 0 ||
    declaration.initializer ||
    !ts.isSourceFile(scope) ||
    mentions(only.value)
  ) {
    return null;
  }
  return { scope, statement, statements, writes, nested: only };
}

/**
 * The expressions a `let` may hold at `read` (see the file comment), in source order, or
 * `undefined` when that can't be told. `refersTo` says whether an identifier names the same
 * variable (the checker's symbol); the declaration's writes are found with the first call's
 * `refersTo` and reused for every later read of it.
 */
export function letValues(
  declaration: ts.VariableDeclaration,
  read: ts.Identifier,
  refersTo: (id: ts.Identifier) => boolean,
): ts.Expression[] | undefined {
  let found = writesCache.get(declaration);
  if (found === undefined) {
    found = writesOf(declaration, refersTo);
    writesCache.set(declaration, found);
  }
  if (!found) return undefined;
  const { scope, statement, statements, writes, nested } = found;
  if (nested) {
    // Read in another function: the one write, or `undefined` (nothing) before it ran.
    if (scopeOf(read) === scope || within(read, nested.scope)) return undefined;
    return [nested.value];
  }
  if (scopeOf(read) !== scope || within(read, statement)) return undefined;

  const hasWrite = (node: ts.Node): boolean => {
    for (const w of writes.keys()) if (within(w, node)) return true;
    return false;
  };

  /** The definitions after a statement runs, or `null` when it never completes normally. */
  const after = (s: ts.Statement, before: Definition[]): Definition[] | null => {
    const written = writes.get(s);
    if (written) return [written];
    if (exits(s)) return null;
    if (!hasWrite(s)) return before;
    if (ts.isBlock(s)) return afterList(s.statements, before);
    if (ts.isIfStatement(s)) {
      const then = after(s.thenStatement, before);
      const otherwise = s.elseStatement ? after(s.elseStatement, before) : before;
      if (then === null) return otherwise;
      if (otherwise === null) return then;
      return union(then, otherwise);
    }
    // Loops, `switch`, `try`, labels: each write inside may or may not have run.
    return union(
      before,
      [...writes].filter(([w]) => within(w, s)).map(([, value]) => value),
    );
  };

  const afterList = (
    statements: readonly ts.Statement[],
    before: Definition[],
  ): Definition[] | null => {
    let current: Definition[] | null = before;
    for (const s of statements) {
      if (current === null) return null;
      current = after(s, current);
    }
    return current;
  };

  /** The definitions reaching `read` inside a statement that contains it. */
  const at = (s: ts.Statement, before: Definition[]): Definition[] | undefined => {
    if (ts.isBlock(s)) return atList(s.statements, before);
    if (ts.isIfStatement(s)) {
      if (within(read, s.expression)) return before;
      if (within(read, s.thenStatement)) return at(s.thenStatement, before);
      if (s.elseStatement && within(read, s.elseStatement)) return at(s.elseStatement, before);
      return undefined;
    }
    if (ts.isExpressionStatement(s) || ts.isReturnStatement(s) || ts.isVariableStatement(s)) {
      // The read is evaluated before the statement's own write, if it has one.
      return before;
    }
    // Loops, `switch`, `try`, labels: a write inside may run before or after the read.
    return hasWrite(s) ? undefined : before;
  };

  const atList = (
    statements: readonly ts.Statement[],
    before: Definition[],
  ): Definition[] | undefined => {
    let current: Definition[] | null = before;
    for (const s of statements) {
      if (current === null) return undefined;
      if (within(read, s)) return at(s, current);
      current = after(s, current);
    }
    return undefined;
  };

  const start = statements.indexOf(statement);
  const initial = declaration.initializer ? [declaration.initializer] : [];
  const values = atList(statements.slice(start + 1), initial);
  if (!values || values.length === 0) return undefined;
  return [...values].sort((a, b) => a.pos - b.pos);
}

/** Two definition lists together, each once. */
function union(a: readonly Definition[], b: readonly Definition[]): Definition[] {
  return [...new Set([...a, ...b])];
}
