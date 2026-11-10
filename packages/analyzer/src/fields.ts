/**
 * Instance fields written once (M9.1a7a, ADR-0253): what `this.<name>` holds when it's read
 * in a class's instance member, for the URL normalizer. anything-llm's `CollectorApi` sets
 * `this.endpoint = \`http://127.0.0.1:${…}\`` in its constructor and every request reads
 * `${this.endpoint}/process`; a provider sets `this.basePath = "https://apipie.ai/v1"` and
 * hands it to its SDK client as `baseURL`.
 *
 * A read is answered with the one expression written to the field when all of these hold:
 * - The read is `this.<name>` (or `this["<name>"]`) in a non-static member of a class (a
 *   method, accessor, constructor, or field initializer), arrow functions in between included;
 *   a `function` in between has its own `this`.
 * - The class writes the field exactly once, as a field initializer (`base = "…"`) or as a
 *   top-level `this.<name> = …;` statement of its constructor. A write in a nested block
 *   (`if (flag) this.url = …`), in another member (`init()`), or a second write leaves the
 *   read unanswered, as does a parameter property (`constructor(private api = …)`) alone.
 * - Nothing else in the program writes a property of that name on a value that may be an
 *   instance of the class: an assignment (`=`, `+=`, `??=`, …), `++`/`--`, `delete`, or a
 *   destructuring or `for…of` target. A write is set aside only when the checker types its
 *   receiver as something that can't be the instance: a primitive, an object literal
 *   (`const o = {}; o.endpoint = …`, JS's expando object too), the class's own constructor
 *   (a static write), or another class's instance when neither class has an `extends` clause
 *   (anything-llm's other providers' `this.basePath = process.env.…`). An `any` receiver
 *   counts.
 * - Nothing in the program writes an unnamed property on a value the checker types as an
 *   instance of the class (`this` in it, the class, a class related to it by `extends`, or
 *   `object`): `x[key] = …` with a computed key, `Object.assign(x, …)`,
 *   `Object.defineProperty(x, …)`, or `Object.defineProperties(x, …)`. A computed key the
 *   checker types as symbols or other literals (`x[Symbol.asyncIterator]`) can't be the field.
 *   Unlike named writes, a receiver typed otherwise doesn't count, `any` included: maps and
 *   untyped values written by key are everywhere in JS (anything-llm's `resource[method] = …`
 *   rebinding SDK methods, `this.mcps[name] = …`, `const plucked = {}; plucked[key] = …`), and
 *   counting them would leave every field of every class unread.
 * - The class declares no accessor or computed member that could be the field, and a read
 *   in the constructor comes after the write (a read in a field initializer, after an earlier
 *   field's initializer).
 *
 * The answer assumes no write the scan can't see, so the normalizer reads it at `heuristic`.
 *
 * Not handled (the read stays a hole):
 * - Static fields and getters, `#private` methods, methods returning a value, and an object
 *   literal's properties read through `this` (M9.1a7b).
 * - A field set through something the scan doesn't name (`Reflect.set`, a prototype), by an
 *   unnamed write on a value not typed as the class (`anyObject[key] = …` in JS, an interface
 *   the class implements; see above), or by code in another service's program. Such writes
 *   aren't looked for.
 * - A field written once in a base class and read in a subclass, or set by a subclass's
 *   constructor: classes with `extends` count each other's writes, so these stay holes.
 */
import ts from "typescript";
import type { ServiceProgram } from "./program.js";
import { propertyName, unwrap } from "./symbols.js";

/** The writes found in one program, indexed by property name. */
interface WriteIndex {
  /** Each written property access (or literal element access), by property name. */
  named: ReadonlyMap<string, readonly ts.Expression[]>;
  /**
   * Writes whose property can't be named: a computed key's write (`x[key] = …`, with its key)
   * or an `Object.assign(x, …)`-style call's target (no key).
   */
  unnamed: readonly { receiver: ts.Expression; key?: ts.Expression }[];
}

/** Reads the value an instance field holds; see the module comment. */
export interface FieldReader {
  /**
   * The expression a `this.<name>` read holds (in `sp`'s program), or `undefined` when the
   * read isn't one of the forms above.
   */
  instanceField(sp: ServiceProgram, read: ts.Expression): ts.Expression | undefined;
}

/** The member whose `this` a node sees: the nearest non-arrow function or class member. */
function thisMember(node: ts.Node): ts.ClassElement | undefined {
  for (let n = node.parent as ts.Node | undefined; n; n = n.parent as ts.Node | undefined) {
    if (ts.isArrowFunction(n)) continue;
    if (
      ts.isFunctionLike(n) ||
      ts.isPropertyDeclaration(n) ||
      ts.isClassStaticBlockDeclaration(n)
    ) {
      return ts.isClassLike(n.parent) && ts.isClassElement(n) ? n : undefined;
    }
    if (ts.isClassLike(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) return undefined;
  }
  return undefined;
}

function isStatic(member: ts.ClassElement): boolean {
  if (ts.isClassStaticBlockDeclaration(member)) return true;
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

/** A member's or parameter's name as written, `#x` for a private one; `undefined` if computed. */
function memberName(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return undefined;
  return propertyName(name);
}

function hasExtends(cls: ts.ClassLikeDeclaration): boolean {
  return (cls.heritageClauses ?? []).some((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
}

/** The property a `this.<name>` or `this["<name>"]` read names, if the receiver is `this`. */
function thisProperty(read: ts.Expression): string | undefined {
  const e = unwrap(read);
  if (ts.isPropertyAccessExpression(e)) {
    return unwrap(e.expression).kind === ts.SyntaxKind.ThisKeyword ? e.name.text : undefined;
  }
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return unwrap(e.expression).kind === ts.SyntaxKind.ThisKeyword
      ? e.argumentExpression.text
      : undefined;
  }
  return undefined;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** True when a property access is written: assigned, updated, deleted, or destructured into. */
function isWritten(target: ts.Expression): boolean {
  let n: ts.Node = target;
  for (;;) {
    const p = n.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p)
    ) {
      n = p;
      continue;
    }
    if (ts.isPropertyAssignment(p) && p.initializer === n) {
      n = p.parent;
      continue;
    }
    if (ts.isBinaryExpression(p)) return p.left === n && isAssignment(p.operatorToken.kind);
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isDeleteExpression(p)) return true;
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === n;
    return false;
  }
}

/** `Object.<name>(target, …)` with `Object` the global. */
function objectCall(call: ts.CallExpression, names: readonly string[]): ts.Expression | undefined {
  const callee = unwrap(call.expression);
  const [target] = call.arguments;
  if (!ts.isPropertyAccessExpression(callee) || !names.includes(callee.name.text)) return undefined;
  const object = unwrap(callee.expression);
  return ts.isIdentifier(object) && object.text === "Object" && target ? target : undefined;
}

/**
 * True when the checker types a computed key as symbols and literals none of which is `name`
 * (`x[Symbol.asyncIterator] = …`, `x[k]` with `k: "a" | "b"`).
 */
function keyIsNot(checker: ts.TypeChecker, key: ts.Expression, name: string): boolean {
  const type = checker.getTypeAtLocation(key);
  return (type.isUnion() ? type.types : [type]).every((t) => {
    if (t.flags & ts.TypeFlags.ESSymbolLike) return true;
    if (t.isStringLiteral()) return t.value !== name;
    if (t.isNumberLiteral()) return String(t.value) !== name;
    return false;
  });
}

/** Every write in a program's own (non-declaration) files. */
function indexWrites(program: ts.Program): WriteIndex {
  const named = new Map<string, ts.Expression[]>();
  const unnamed: { receiver: ts.Expression; key?: ts.Expression }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isWritten(node)) {
      const list = named.get(node.name.text) ?? [];
      list.push(node);
      named.set(node.name.text, list);
    } else if (ts.isElementAccessExpression(node) && isWritten(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) {
        const list = named.get(key.text) ?? [];
        list.push(node);
        named.set(key.text, list);
      } else {
        unnamed.push({ receiver: node.expression, key });
      }
    } else if (ts.isCallExpression(node)) {
      const target = objectCall(node, ["assign", "defineProperty", "defineProperties"]);
      if (target) unnamed.push({ receiver: target });
    }
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) {
    if (!file.isDeclarationFile) visit(file);
  }
  return { named, unnamed };
}

/** Create a {@link FieldReader} over a resolver's checkers. */
export function createFieldReader(checkerOf: (sp: ServiceProgram) => ts.TypeChecker): FieldReader {
  const indexes = new WeakMap<ts.Program, WriteIndex>();
  const writesOf = (program: ts.Program): WriteIndex => {
    let index = indexes.get(program);
    if (!index) {
      index = indexWrites(program);
      indexes.set(program, index);
    }
    return index;
  };

  /** True when the checker says a named write's receiver can't be an instance of `cls`. */
  const notAnInstance = (
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    cls: ts.ClassLikeDeclaration,
  ): boolean => {
    const type = checker.getTypeAtLocation(receiver);
    const PRIMITIVE =
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void |
      ts.TypeFlags.Never;
    return (type.isUnion() ? type.types : [type]).every((t) => {
      if (t.flags & PRIMITIVE) return true;
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      const symbol = t.getSymbol();
      if (!symbol) return false;
      if (symbol.flags & ts.SymbolFlags.ObjectLiteral) return true;
      // A JS `const o = {}` with properties added later is typed by the variable's symbol.
      const d = symbol.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        if (ts.isObjectLiteralExpression(unwrap(d.initializer))) return true;
      }
      if (!(symbol.flags & ts.SymbolFlags.Class)) return false;
      if (checker.getTypeOfSymbol(symbol) === t) return true; // `typeof C`: a static write
      const other = symbol.declarations?.find(ts.isClassLike);
      return other !== undefined && other !== cls && !hasExtends(other) && !hasExtends(cls);
    });
  };

  /**
   * True when an unnamed write's receiver is typed as an instance of `cls`: a part of its type
   * (a union's or intersection's member, a type parameter's constraint, so `this` too) is
   * `object` or an instance of `cls`, or of another class when either has `extends`.
   */
  const typedAsInstance = (
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    cls: ts.ClassLikeDeclaration,
  ): boolean => {
    const type = checker.getTypeAtLocation(receiver);
    const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
    return parts.some((part) => {
      const t = part.isTypeParameter() ? (checker.getBaseConstraintOfType(part) ?? part) : part;
      if (t.flags & ts.TypeFlags.NonPrimitive) return true; // `object`
      const symbol = t.getSymbol();
      if (!symbol || !(symbol.flags & ts.SymbolFlags.Class)) return false;
      if (checker.getTypeOfSymbol(symbol) === t) return false; // `typeof C`: the class itself
      const other = symbol.declarations?.find(ts.isClassLike);
      return other === cls || (other !== undefined && (hasExtends(other) || hasExtends(cls)));
    });
  };

  const instanceField = (sp: ServiceProgram, read: ts.Expression): ts.Expression | undefined => {
    const name = thisProperty(read);
    const member = name === undefined ? undefined : thisMember(read);
    if (name === undefined || !member || isStatic(member)) return undefined;
    const cls = member.parent as ts.ClassLikeDeclaration;

    /** Each write the class itself makes: `[value, node it takes effect at]`. */
    const own: [ts.Expression, ts.Node][] = [];
    for (const m of cls.members) {
      if (isStatic(m)) continue;
      // A parameter property (`constructor(private api = …)`) is set from the arguments, so
      // it's no write the field can be read from; a later constructor statement overrides it.
      if (!m.name || ts.isConstructorDeclaration(m)) continue;
      const named = memberName(m.name);
      if (named !== name && named !== undefined) continue;
      // An accessor, method, or computed member that could be the field.
      if (!ts.isPropertyDeclaration(m) || named === undefined) return undefined;
      if (m.initializer) own.push([m.initializer, m]);
    }
    const checker = checkerOf(sp);
    const index = writesOf(sp.program);
    for (const target of index.named.get(name) ?? []) {
      const receiver = unwrap(
        (target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
      );
      const writer = receiver.kind === ts.SyntaxKind.ThisKeyword ? thisMember(target) : undefined;
      if (writer && writer.parent === cls && !isStatic(writer)) {
        // The class's own write: only `this.<name> = …;` at the top of the constructor counts.
        const assignment = target.parent;
        const statement = assignment.parent as ts.Node | undefined;
        const once =
          ts.isConstructorDeclaration(writer) &&
          ts.isBinaryExpression(assignment) &&
          assignment.left === target &&
          assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          statement !== undefined &&
          ts.isExpressionStatement(statement) &&
          statement.parent === writer.body;
        if (!once) return undefined;
        own.push([assignment.right, statement]);
      } else if (!notAnInstance(checker, receiver, cls)) {
        return undefined;
      }
    }
    const mayWrite = ({ receiver, key }: { receiver: ts.Expression; key?: ts.Expression }) =>
      !(key && keyIsNot(checker, key, name)) && typedAsInstance(checker, unwrap(receiver), cls);
    if (index.unnamed.some(mayWrite)) return undefined;

    const [only, ...more] = own;
    if (!only || more.length > 0) return undefined;
    const [value, at] = only;
    // A read that runs before the write sees `undefined`. Field initializers run first.
    if (ts.isConstructorDeclaration(member)) {
      return ts.isPropertyDeclaration(at) || at.end <= read.pos ? value : undefined;
    }
    if (ts.isPropertyDeclaration(member)) {
      return ts.isPropertyDeclaration(at) && at.end <= member.pos ? value : undefined;
    }
    return value;
  };

  return { instanceField };
}
