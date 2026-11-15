/**
 * Class and object members holding a URL base (M9.1a7a, ADR-0253; M9.1a7b, ADR-0254).
 *
 * Instance fields written once (M9.1a7a): what `this.<name>` holds when it's read
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
 *   read unanswered. A parameter property (`constructor(private api = …)`) is no such write:
 *   with no other write, it's read as its default (M12.1d, below) or not at all.
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
 * Parameter property defaults (M12.1d, ADR-0306): sea-notes-saas-starter-kit's API clients
 * declare `constructor(private baseURL = '/api/notes') {}` and read `${this.baseURL}/…`; the
 * app builds them with `new NotesApiClient()`. When the class writes the field nowhere else,
 * the read is the parameter's default if all of these hold (besides the write rules above):
 * - The class is a named declaration (overloaded constructors too: arguments land at the same
 *   positions of the implementation). A read in a field initializer stays unanswered.
 * - The program constructs the class at least once, and only as `new <name>(…)` (its own name,
 *   an import or export alias, or `ns.<name>` through a namespace import) with no argument at
 *   the parameter's position and no spread argument. A passed `undefined` counts as passing.
 * - Its name is used as a value nowhere else (passed, assigned, `{ C }`, `extends C`,
 *   `Reflect.construct(C, …)`); types (`x: C`, `typeof C`, `implements C`) don't count. No
 *   member of the class calls `new this(…)`, and nothing in the program calls
 *   `new x.constructor(…)`.
 * Code in another service's program that constructs the class isn't seen (as for writes).
 *
 * Static and object members (M9.1a7b): anything-llm's `FoundryCatalog.CATALOG_URL` (a static
 * field), `EmbeddedLemonadeEngine.baseUrl` (a static getter returning
 * `\`http://127.0.0.1:${port()}\``), `EmbeddedLemonadeLLM.openaiBasePath()` (a static method),
 * Gmail's `this.#getBaseUrl()` (a private method), and `CommunityHub`'s `this.apiBase` (an
 * object literal's own property). `classMember` names the member a read reaches:
 * - The read is `<Class>.<name>` with `<Class>` naming a class declaration, or `this.<name>`
 *   in a static member (the class itself) or, for a `#private` name, in any member.
 * - The class declares exactly one member of that name and kind (static or not), with no
 *   computed member of that kind beside it that could be it: a static field with an
 *   initializer (its value), or a method or getter (the normalizer reads its body as a string
 *   builder). A getter with a setter is two members, so it's left alone, as is a public
 *   instance method or getter, which a subclass may override.
 * - `this` in a static member may be a subclass, whose own static member wins, so a public
 *   static member read through `this` needs no class in the program to extend its class.
 * - Nothing in the program writes a property of that name on a value that may be the class
 *   itself (named writes: set aside only when the checker types the receiver as a primitive,
 *   an object literal, an instance, or another class; an `any` receiver counts), and no
 *   unnamed write targets a value typed as the class or `object`. A `#private` method or
 *   getter can't be assigned, so it isn't looked for.
 *
 * `objectMember` reads `this.<name>` in a method or `function` property of an object literal
 * that is a variable's initializer (`const Hub = { apiBase: "…", explore() { … } }`): the
 * literal's own property (`objectProperty`: a spread or computed key that could supply it
 * leaves it unread), when no named write may land on that object (its own type, `object`, or
 * `any`) and no unnamed write on one typed as it. `this` is the object only when the method
 * is called on it (`Hub.explore()`), which the scan assumes; hence `heuristic` too.
 *
 * Not handled (the read stays a hole):
 * - Public instance methods and getters (`this.url()`), and static members of a class some
 *   class in the program extends when read through `this`; a static member inherited from a
 *   base class (`Sub.base` declared on `Base`); a class held in a variable (`const C = class
 *   {…}`); and an object literal that isn't a variable's initializer (returned, nested, or
 *   passed), or whose method is an arrow function (its `this` is the enclosing one).
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
import { objectProperty } from "./values.js";

/** Types no property write can land on an object through. */
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

/**
 * A read of a class member (M9.1a7b): `this.<name>` in one of the class's members, or
 * `<Class>.<name>` naming the class itself.
 */
export interface MemberAccess {
  cls: ts.ClassLikeDeclaration;
  /** The member's name as written, `#x` for a private one. */
  name: string;
  /** True when the read is of the class itself (a static member). */
  isStatic: boolean;
  /** True when the receiver is `this`, which a subclass may be. */
  viaThis: boolean;
}

/** What a class member holds: a static field's initializer, or a getter or method. */
export type ClassMember =
  | { value: ts.Expression }
  | { fn: ts.MethodDeclaration | ts.GetAccessorDeclaration };

/** Reads the value an instance field holds; see the module comment. */
export interface FieldReader {
  /**
   * The expression a `this.<name>` read holds (in `sp`'s program), or `undefined` when the
   * read isn't one of the forms above.
   */
  instanceField(sp: ServiceProgram, read: ts.Expression): ts.Expression | undefined;
  /**
   * The static field, static getter or method, or `#private` method or getter a read names
   * (M9.1a7b), when nothing may replace it; see the module comment.
   */
  classMember(sp: ServiceProgram, access: MemberAccess): ClassMember | undefined;
  /**
   * The value of the property a `this.<name>` read names in a method of a variable's object
   * literal (M9.1a7b), when nothing may write it; see the module comment.
   */
  objectMember(sp: ServiceProgram, read: ts.Expression): ts.Expression | undefined;
}

/** The {@link MemberAccess} a `this.<name>` read in a class member is, if it is one. */
export function thisAccess(read: ts.Expression): MemberAccess | undefined {
  const name = thisProperty(read);
  const member = name === undefined ? undefined : thisMember(read);
  if (name === undefined || !member) return undefined;
  const cls = member.parent as ts.ClassLikeDeclaration;
  return { cls, name, isStatic: isStatic(member), viaThis: true };
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

/**
 * The constructor parameter property (`private x = …`) of that name and its position, if the
 * class has one. Only a constructor's implementation (the one with a body) declares them.
 */
function parameterProperty(
  cls: ts.ClassLikeDeclaration,
  name: string,
): { parameter: ts.ParameterDeclaration; index: number } | undefined {
  const ctor = cls.members.find(
    (m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined,
  );
  const index =
    ctor?.parameters.findIndex(
      (p) => ts.isParameterPropertyDeclaration(p, ctor) && memberName(p.name) === name,
    ) ?? -1;
  const parameter = ctor?.parameters[index];
  return parameter && index >= 0 ? { parameter, index } : undefined;
}

/** True for a node in a type (`x: C`, `typeof C`, `implements C`), not a value. */
function inType(node: ts.Node): boolean {
  for (let n = node.parent as ts.Node | undefined; n; n = n.parent as ts.Node | undefined) {
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) {
      return n.parent.token === ts.SyntaxKind.ImplementsKeyword || !ts.isClassLike(n.parent.parent);
    }
    if (ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

/** True for a name that only declares or passes on an alias of a value (imports, exports). */
function isAliasName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    (ts.isExportAssignment(p) && p.expression === id)
  );
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

  const built = new WeakMap<ts.ClassLikeDeclaration, readonly ts.NewExpression[] | undefined>();
  /**
   * Every `new` of a named class declaration in the program (M12.1d), or `undefined` when it
   * may be constructed some other way: its name used as a value other than `new <name>(…)`
   * (passed, assigned, `extends`, `Reflect.construct`), `new this(…)` in one of its members,
   * or `new x.constructor(…)` anywhere.
   */
  const constructions = (
    sp: ServiceProgram,
    cls: ts.ClassLikeDeclaration,
  ): readonly ts.NewExpression[] | undefined => {
    if (built.has(cls)) return built.get(cls);
    const checker = checkerOf(sp);
    const resolve = (s: ts.Symbol | undefined): ts.Symbol | undefined =>
      s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    const symbol =
      ts.isClassDeclaration(cls) && cls.name ? checker.getSymbolAtLocation(cls.name) : undefined;
    const files = sp.program.getSourceFiles().filter((f) => !f.isDeclarationFile);
    // The names the class goes by: its own, and each import or export alias of it.
    const names = new Set<string>(cls.name ? [cls.name.text] : []);
    for (const file of files) {
      for (const statement of file.statements) {
        const aliases: ts.ModuleExportName[] = [];
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const { name, namedBindings } = statement.importClause;
          if (name) aliases.push(name);
          if (namedBindings && ts.isNamedImports(namedBindings)) {
            aliases.push(...namedBindings.elements.map((e) => e.name));
          }
        } else if (
          ts.isExportDeclaration(statement) &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          aliases.push(...statement.exportClause.elements.map((e) => e.name));
        }
        for (const a of aliases) {
          if (symbol && resolve(checker.getSymbolAtLocation(a)) === symbol) names.add(a.text);
        }
      }
    }
    let news: ts.NewExpression[] | undefined = [];
    const visit = (node: ts.Node): void => {
      if (!news) return;
      if (ts.isNewExpression(node)) {
        const callee = unwrap(node.expression);
        const viaThis =
          callee.kind === ts.SyntaxKind.ThisKeyword && thisMember(node)?.parent === cls;
        if (
          viaThis ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor")
        ) {
          news = undefined;
          return;
        }
      }
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        node !== cls.name &&
        !isAliasName(node)
      ) {
        // `{ C }` names the property; the value it holds is the class.
        const at = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        if (resolve(at) === symbol && !inType(node)) {
          // `new C(…)`, or `new ns.C(…)` through a namespace import.
          const named = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
          const e = named ? node.parent : node;
          if (ts.isNewExpression(e.parent) && e.parent.expression === e) news.push(e.parent);
          else news = undefined;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    if (symbol) for (const file of files) visit(file);
    else news = undefined;
    built.set(cls, news);
    return news;
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
    if (more.length > 0) return undefined;
    if (!only) {
      // A parameter property's default (M12.1d), set as the constructor starts, before any
      // field initializer or statement can read it.
      const property = parameterProperty(cls, name);
      const value = property?.parameter.initializer;
      if (!property || !value || ts.isPropertyDeclaration(member)) return undefined;
      const news = constructions(sp, cls);
      if (!news?.length) return undefined;
      const bare = news.every((n) => {
        const args = n.arguments ?? [];
        return args.length <= property.index && !args.some(ts.isSpreadElement);
      });
      return bare ? value : undefined;
    }
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

  /** True when the checker says a named write's receiver can't be the class itself. */
  const notTheClass = (
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    cls: ts.ClassLikeDeclaration,
  ): boolean => {
    const type = checker.getTypeAtLocation(receiver);
    return (type.isUnion() ? type.types : [type]).every((t) => {
      if (t.flags & PRIMITIVE) return true;
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
      const symbol = t.getSymbol();
      if (!symbol) return false;
      if (symbol.flags & ts.SymbolFlags.ObjectLiteral) return true;
      const d = symbol.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        if (ts.isObjectLiteralExpression(unwrap(d.initializer))) return true;
      }
      if (!(symbol.flags & ts.SymbolFlags.Class)) return false;
      // An instance, or another class: a static write to a subclass is the subclass's own.
      if (checker.getTypeOfSymbol(symbol) !== t) return true;
      return !symbol.declarations?.includes(cls);
    });
  };

  /** True when an unnamed write's receiver is typed as `object` or as the class itself. */
  const typedAsClass = (
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    cls: ts.ClassLikeDeclaration,
  ): boolean => {
    const type = checker.getTypeAtLocation(receiver);
    const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
    return parts.some((t) => {
      if (t.flags & ts.TypeFlags.NonPrimitive) return true;
      const symbol = t.getSymbol();
      if (!symbol || !(symbol.flags & ts.SymbolFlags.Class)) return false;
      return checker.getTypeOfSymbol(symbol) === t && (symbol.declarations?.includes(cls) ?? false);
    });
  };

  const subclassed = new WeakMap<ts.Program, Set<ts.Declaration>>();
  /** Every class declaration some class in the program `extends`, as the checker resolves it. */
  const extendedIn = (sp: ServiceProgram): Set<ts.Declaration> => {
    let found = subclassed.get(sp.program);
    if (found) return found;
    found = new Set();
    const checker = checkerOf(sp);
    const visit = (node: ts.Node): void => {
      if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) {
        for (const type of node.types) {
          let symbol = checker.getSymbolAtLocation(type.expression);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            symbol = checker.getAliasedSymbol(symbol);
          }
          for (const d of symbol?.declarations ?? []) found.add(d);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const file of sp.program.getSourceFiles()) {
      if (!file.isDeclarationFile) visit(file);
    }
    subclassed.set(sp.program, found);
    return found;
  };

  const classMember = (sp: ServiceProgram, access: MemberAccess): ClassMember | undefined => {
    const { cls, name } = access;
    const isPrivate = name.startsWith("#");
    // A public instance method or getter may be a subclass's override; fields are
    // `instanceField`'s.
    if (!access.isStatic && !isPrivate) return undefined;
    const named: ts.ClassElement[] = [];
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m) || ts.isClassStaticBlockDeclaration(m) || !m.name)
        continue;
      const n = memberName(m.name);
      if (n === undefined) {
        if (access.isStatic === isStatic(m)) return undefined; // a computed member could be it
        continue;
      }
      if (n === name && isStatic(m) === access.isStatic) named.push(m);
    }
    const [only, ...more] = named;
    if (!only || more.length > 0) return undefined;
    // `this` in a static member may be a subclass, whose own static member of that name wins.
    if (access.isStatic && access.viaThis && !isPrivate && extendedIn(sp).has(cls)) {
      return undefined;
    }
    let found: ClassMember;
    if (ts.isPropertyDeclaration(only) && access.isStatic && only.initializer) {
      found = { value: only.initializer };
    } else if (ts.isMethodDeclaration(only) || ts.isGetAccessorDeclaration(only)) {
      found = { fn: only };
    } else {
      return undefined;
    }
    // A `#private` method or getter can't be assigned; anything static can be.
    if (!isPrivate || "value" in found) {
      const checker = checkerOf(sp);
      const index = writesOf(sp.program);
      for (const target of index.named.get(name) ?? []) {
        const receiver = unwrap(
          (target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
        );
        if (!notTheClass(checker, receiver, cls)) return undefined;
      }
      const mayWrite = ({ receiver, key }: { receiver: ts.Expression; key?: ts.Expression }) =>
        !(key && keyIsNot(checker, key, name)) && typedAsClass(checker, unwrap(receiver), cls);
      if (index.unnamed.some(mayWrite)) return undefined;
    }
    return found;
  };

  const objectMember = (sp: ServiceProgram, read: ts.Expression): ts.Expression | undefined => {
    const name = thisProperty(read);
    if (name === undefined) return undefined;
    // The nearest function with its own `this` (arrow functions see their parent's).
    let fn: ts.Node | undefined = read.parent;
    while (
      fn &&
      (ts.isArrowFunction(fn) ||
        !(ts.isFunctionLike(fn) || ts.isSourceFile(fn) || ts.isClassLike(fn)))
    ) {
      fn = fn.parent as ts.Node | undefined;
    }
    if (!fn) return undefined;
    // The object literal whose method (or function-valued property) `this` is read in.
    let object: ts.Node | undefined;
    if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) object = fn.parent;
    else if (ts.isFunctionExpression(fn) && ts.isPropertyAssignment(fn.parent)) {
      object = fn.parent.parent;
    }
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    const declaration = object.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== object) {
      return undefined;
    }
    const value = objectProperty(sp, object, name);
    if (!value) return undefined;

    const checker = checkerOf(sp);
    const objectSymbol = checker.getTypeAtLocation(object).getSymbol();
    /** True when a receiver may be this object (`any` too, for named writes). */
    const mayBe = (receiver: ts.Expression, anyCounts: boolean): boolean => {
      const type = checker.getTypeAtLocation(receiver);
      const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
      return parts.some((t) => {
        if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return anyCounts;
        if (t.flags & ts.TypeFlags.NonPrimitive) return true;
        const symbol = t.getSymbol();
        if (!symbol) return false;
        return symbol === objectSymbol || symbol.valueDeclaration === declaration;
      });
    };
    const index = writesOf(sp.program);
    for (const target of index.named.get(name) ?? []) {
      const receiver = unwrap(
        (target as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression,
      );
      if (mayBe(receiver, true)) return undefined;
    }
    const mayWrite = ({ receiver, key }: { receiver: ts.Expression; key?: ts.Expression }) =>
      !(key && keyIsNot(checker, key, name)) && mayBe(unwrap(receiver), false);
    if (index.unnamed.some(mayWrite)) return undefined;
    return value.expression;
  };

  return { instanceField, classMember, objectMember };
}
