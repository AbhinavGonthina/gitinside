/**
 * Static value tracing shared by the HTTP collector (M2.1) and the URL normalizer (M2.2):
 * following identifiers to their declarations (through imports, workspace packages too),
 * reading `const` strings, and reading properties of object literals. Nothing here runs code;
 * a value the reader can't prove is reported as unknown.
 */
import ts from "typescript";
import type { Confidence } from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";

/** How many alias, variable, or return hops are followed before giving up. */
export const MAX_HOPS = 16;

/** An expression and the program whose checker understands it. */
export interface ProgramExpression {
  sp: ServiceProgram;
  expression: ts.Expression;
}

/** A property read from an object literal: absent, unknown (`null`), or its value. */
export type ConfigValue = ProgramExpression | null | undefined;

/** A declaration and the program that understands it, with how surely it was reached. */
export interface FoundDeclaration {
  sp: ServiceProgram;
  declaration: ts.Declaration;
  confidence: Confidence;
}

/** An object literal a `const` holds, and how surely it was reached. */
export interface ConstObject {
  sp: ServiceProgram;
  expression: ts.ObjectLiteralExpression;
  confidence: Confidence;
}

/** The weaker of two confidences, for values reached through a heuristic import. */
export const weaker = (a: Confidence, b: Confidence): Confidence => (a === "exact" ? b : a);

/** True when a variable is declared with `const`. */
export function isConst(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * A property of an object literal: its value, `undefined` when it is certainly absent, or
 * `null` when a spread or a computed key could supply it.
 */
export function objectProperty(
  sp: ServiceProgram,
  object: ts.ObjectLiteralExpression,
  name: string,
): ConfigValue {
  for (let i = object.properties.length - 1; i >= 0; i--) {
    const property = object.properties[i];
    if (!property) continue;
    const value = ownProperty(sp, property, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * What one object literal member says about property `name`: its value, `undefined` when it
 * is another property, or `null` when it is a spread, a computed key that could be `name`,
 * or a method or accessor named `name`.
 */
export function ownProperty(
  sp: ServiceProgram,
  property: ts.ObjectLiteralElementLike,
  name: string,
): ConfigValue {
  if (ts.isSpreadAssignment(property)) return null;
  const key = property.name;
  if (key && ts.isComputedPropertyName(key)) {
    if (!ts.isStringLiteralLike(key.expression)) return null;
    if (key.expression.text !== name) return undefined;
  } else if (!key || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || key.text !== name) {
    return undefined;
  }
  if (ts.isPropertyAssignment(property)) return { sp, expression: property.initializer };
  if (ts.isShorthandPropertyAssignment(property)) return { sp, expression: property.name };
  return null; // a method or accessor
}

/** Readers bound to one resolver's checkers. */
export interface ValueReader {
  /**
   * The checker symbol an identifier or property name refers to, before alias resolution.
   * For the name of a shorthand property (`{ method }`), the value it reads.
   */
  symbolAt(sp: ServiceProgram, node: ts.Node): ts.Symbol | undefined;
  /**
   * Follow an alias (including a workspace-package import TypeScript couldn't resolve) to
   * the first declaration of the symbol it names, with the program that understands it.
   */
  resolveDeclaration(
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): FoundDeclaration | undefined;
  /**
   * A const object literal an expression names (`METHODS` in `METHODS.post`), with the
   * weakest confidence of the imports crossed to reach it.
   */
  constObject(sp: ServiceProgram, expression: ts.Expression, hops: number): ConstObject | undefined;
  /**
   * The string an expression always holds: string literals, `const`s holding one (imported
   * too), properties of const object literals, and string enum members.
   */
  constString(sp: ServiceProgram, expression: ts.Expression, hops: number): string | undefined;
  /** The value of a string enum member a property access names (`Verb.Patch`). */
  enumString(sp: ServiceProgram, expression: ts.PropertyAccessExpression): string | undefined;
}

/** Create a {@link ValueReader} over a resolver's checkers. */
export function createValueReader(resolver: SymbolResolver): ValueReader {
  const symbolAt = (sp: ServiceProgram, node: ts.Node): ts.Symbol | undefined => {
    const checker = resolver.checkerOf(sp);
    const parent = node.parent as ts.Node | undefined;
    return parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
  };

  const resolveDeclaration = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): FoundDeclaration | undefined => {
    if (hops > MAX_HOPS) return undefined;
    if (start.flags & ts.SymbolFlags.Alias) {
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(start);
      const declaration = aliased.declarations?.[0];
      if (declaration) return { sp, declaration, confidence: "exact" };
      const alias = start.declarations?.[0];
      const target = alias && resolver.importTarget(sp, alias);
      if (!target) return undefined;
      const found = resolveDeclaration(target.sp, target.symbol, hops + 1);
      return found && { ...found, confidence: weaker(target.confidence, found.confidence) };
    }
    const declaration = start.declarations?.[0];
    return declaration && { sp, declaration, confidence: "exact" };
  };

  const constObject = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): ConstObject | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isObjectLiteralExpression(e)) return { sp, expression: e, confidence: "exact" };
    if (ts.isPropertyAccessExpression(e)) {
      // A nested object, `ROUTES.admin` in `ROUTES.admin.users`.
      const outer = constObject(sp, e.expression, hops + 1);
      const value = outer && objectProperty(outer.sp, outer.expression, e.name.text);
      const inner = value ? constObject(value.sp, value.expression, hops + 1) : undefined;
      return outer && inner
        ? { ...inner, confidence: weaker(outer.confidence, inner.confidence) }
        : undefined;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const symbol = symbolAt(sp, e);
    const found = symbol && resolveDeclaration(sp, symbol, hops + 1);
    const d = found?.declaration;
    if (!found || !d || !ts.isVariableDeclaration(d) || !d.initializer || !isConst(d)) {
      return undefined;
    }
    const inner = constObject(found.sp, d.initializer, hops + 1);
    return inner && { ...inner, confidence: weaker(found.confidence, inner.confidence) };
  };

  const enumString = (
    sp: ServiceProgram,
    expression: ts.PropertyAccessExpression,
  ): string | undefined => {
    const member = symbolAt(sp, expression.name)?.valueDeclaration;
    if (!member || !ts.isEnumMember(member)) return undefined;
    const value = resolver.checkerOf(sp).getConstantValue(member);
    return typeof value === "string" ? value : undefined;
  };

  const constString = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): string | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isIdentifier(e)) {
      const symbol = symbolAt(sp, e);
      const found = symbol && resolveDeclaration(sp, symbol, hops + 1);
      const d = found?.declaration;
      if (found && d && ts.isVariableDeclaration(d) && d.initializer && isConst(d)) {
        return constString(found.sp, d.initializer, hops + 1);
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const fromEnum = enumString(sp, e);
      if (fromEnum !== undefined) return fromEnum;
      const object = constObject(sp, e.expression, hops + 1);
      const value = object && objectProperty(object.sp, object.expression, e.name.text);
      return value ? constString(value.sp, value.expression, hops + 1) : undefined;
    }
    return undefined;
  };

  return { symbolAt, resolveDeclaration, constObject, constString, enumString };
}
