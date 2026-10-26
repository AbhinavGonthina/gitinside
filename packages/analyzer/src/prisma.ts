/**
 * Prisma detector (M1.12): `model` nodes from `.prisma` schema files, `datastore` nodes from
 * their `datasource` blocks with `stores` edges, and `reads`/`writes` edges from Prisma
 * client calls to the models they touch.
 *
 * Patterns handled:
 * - Schema files: every `.prisma` file in the inventory, so both a single `schema.prisma` and
 *   multi-file schemas (`prisma/schema/*.prisma`) work. `model` and `view` blocks become
 *   `model:<service>/<Name>` nodes parented to their schema file, with fields in declaration
 *   order (`Post[]` keeps its `[]` in the type, `String?` is `optional`, `Unsupported("…")`
 *   is kept verbatim). Relations are fields whose type names another model. `enum`, `type`,
 *   and `generator` blocks and `@@` block attributes produce nothing. A model name seen twice
 *   in one service keeps the first (by file, then line), with `PRISMA_DUPLICATE_MODEL`.
 * - Datasources: `provider = "postgresql"` (also `mysql`, `sqlite`, `sqlserver`, `mongodb`,
 *   `cockroachdb`) becomes `datastore:infra/<service>/<schema file>#<name>` with its engine,
 *   and every model of that file, or of the service when its schema has one datasource across
 *   several files, gets a `stores` edge. A provider that isn't a string literal gets a
 *   `PRISMA_DYNAMIC_PROVIDER` warning and no datastore.
 * - Client calls: `<client>.<model>.<op>(…)` where `<model>` is a model name with its first
 *   letter lowercased (Prisma's accessor) and `<op>` is a read (`find*`, `count`, `aggregate`,
 *   `groupBy`, `findRaw`, `aggregateRaw`) or a write (`create*`, `update*`, `upsert`,
 *   `delete*`). The receiver is a client when the checker traces it, through variables,
 *   imports (workspace packages too, via the shared resolver), `export default`, CommonJS
 *   exports, class properties, `??`/`||`, ternaries, `await`, `$extends(…)`, and factory
 *   functions, to `new PrismaClient()` (or a class extending it), or to a declaration typed
 *   `PrismaClient`, `Prisma.TransactionClient`, or such a class. The first parameter of a
 *   callback passed to `client.$transaction` is a client too. Those edges are `exact`.
 * - Receivers the checker can't trace (untyped `ctx.db`) still count when their name is
 *   `db`, `database`, `client`, `tx`, `trx`, or contains `prisma`, and the model and op
 *   match; those edges are `heuristic`.
 * - The model is looked up in the schema of the service that created (or typed) the client,
 *   else of the calling service, else the single service whose schema has it (`heuristic`
 *   when several services have schemas). Several candidates make an `unresolved` node with
 *   reason `AMBIGUOUS`; a traced client naming no known model makes one with
 *   `UNKNOWN_SYMBOL`.
 * - Fields: top-level keys of `select`, `include`, `omit`, `where` (through `AND`/`OR`/
 *   `NOT`), `having`, `orderBy`, `cursor`, `distinct`, `by`, `data`, `create`, `update`,
 *   and the aggregate selectors (`_count`, …) that name a field of the model are listed in
 *   the edge's `fields`, sorted.
 * - Raw queries: `$queryRaw`, `$queryRawUnsafe`, `$queryRawTyped` (reads) and `$executeRaw`,
 *   `$executeRawUnsafe`, `$runCommandRaw` (writes) on a traced client, tagged or called,
 *   become `unresolved` nodes with reason `RAW_QUERY`, because the model is unknown.
 * - The edge source is the innermost symbol containing the call, or the Express route an
 *   inline handler serves (`router.get("/", async (req, res) => prisma.user.findMany())`).
 *   Calls with neither (top-level code) get no edge; their `unresolved` nodes are still kept.
 *
 * Patterns not handled:
 * - Clients stored in collections or obtained through destructuring (`const { db } = ctx`)
 *   unless the name matches the heuristic above; model delegates held in variables
 *   (`const users = prisma.user; users.findMany()`); computed access (`prisma[model]`).
 * - Generic repository wrappers (`repo<T>(delegate)`), Prisma Pulse/Accelerate extensions'
 *   own methods, and `@@map`/`@map` table names (model names are used as-is).
 * - Nested writes and relation filters: only top-level keys are read, so `data: { posts:
 *   { create: … } }` lists `posts` on the parent model and draws no edge to `Post`.
 * - Schema files are parsed line by line, never by Prisma's engines: a block must open with
 *   `keyword Name {` on one line and close with `}` on its own line.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import {
  SYSTEM_ID,
  compareStrings,
  edgeId,
  nodeId,
  type AnalysisWarning,
  type Confidence,
  type GraphEdge,
  type GraphNode,
  type SourceLocation,
  type UnresolvedReason,
} from "@gitinside/schema";
import type { SymbolResolver } from "./calls.js";
import { isFunctionWithBody, returnedExpressions } from "./express.js";
import { fileNodeId, withinService } from "./files.js";
import type { ServiceProgram } from "./program.js";
import { unwrap } from "./symbols.js";
import { serviceForFile, type Workspace, type WorkspacePackage } from "./workspace.js";

/** How many alias, variable, or return hops are followed before giving up. */
const MAX_HOPS = 16;

/** Model delegate methods that only read. */
const READ_OPS: ReadonlySet<string> = new Set([
  "aggregate",
  "aggregateRaw",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findRaw",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);

/** Model delegate methods that write. */
const WRITE_OPS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/** Client methods that run raw queries, and the edge kind each implies. */
const RAW_OPS: ReadonlyMap<string, "reads" | "writes"> = new Map([
  ["$executeRaw", "writes"],
  ["$executeRawUnsafe", "writes"],
  ["$queryRaw", "reads"],
  ["$queryRawTyped", "reads"],
  ["$queryRawUnsafe", "reads"],
  ["$runCommandRaw", "writes"],
]);

/** Prisma `provider` values and the datastore engine each maps to. */
const ENGINES: ReadonlyMap<string, string> = new Map([
  ["cockroachdb", "cockroachdb"],
  ["mongodb", "mongo"],
  ["mysql", "mysql"],
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["sqlite", "sqlite"],
  ["sqlserver", "sqlserver"],
]);

/** Query-argument keys whose (top-level) keys name model fields. */
const FIELD_KEYS: ReadonlySet<string> = new Set([
  "_avg",
  "_count",
  "_max",
  "_min",
  "_sum",
  "by",
  "create",
  "cursor",
  "data",
  "distinct",
  "having",
  "include",
  "omit",
  "orderBy",
  "select",
  "update",
  "where",
]);

/** Filter combinators inside `where`/`having` whose values hold more field keys. */
const LOGICAL_KEYS: ReadonlySet<string> = new Set(["AND", "NOT", "OR"]);

/** Type names that mean "a Prisma client" in an annotation. */
const CLIENT_TYPE = /\b(?:PrismaClient|TransactionClient)\b/;

/** Receiver names trusted as a client when the checker can't trace them (`heuristic`). */
const CLIENT_NAME = /prisma|^(?:db|database|client|tx|trx)$/i;

/** Longest `expression` kept for a raw query; longer source text is cut with `…`. */
const MAX_EXPRESSION = 120;

/** A field of a parsed model. */
export interface PrismaField {
  name: string;
  /** The type as written, without `?`: `String`, `Post[]`, `Unsupported("tsvector")`. */
  type: string;
  optional: boolean;
}

/** A `model` or `view` block. Lines and columns are 1-based. */
export interface PrismaModel {
  name: string;
  fields: PrismaField[];
  line: number;
  column: number;
  endLine: number;
}

/** A `datasource` block. `provider` is undefined when it isn't a string literal. */
export interface PrismaDatasource {
  name: string;
  provider: string | undefined;
  line: number;
  column: number;
}

/** The parts of a schema file the detector uses. */
export interface PrismaSchema {
  models: PrismaModel[];
  datasources: PrismaDatasource[];
  /** Lines that couldn't be parsed, in order. */
  errors: { line: number; message: string }[];
}

/** A line with its `//` comment removed, ignoring `//` inside string literals. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

const BLOCK_START = /^([A-Za-z]\w*)\s+([A-Za-z_]\w*)\s*\{\s*(\})?$/;
const FIELD =
  /^([A-Za-z_]\w*)\s+(Unsupported\("(?:[^"\\]|\\.)*"\)|[A-Za-z_][\w.]*)(\[\])?(\?)?(?=\s|@|$)/;
const PROVIDER = /^provider\s*=\s*(.*)$/;
const STRING_LITERAL = /^"((?:[^"\\]|\\.)*)"$/;

/**
 * Parse the models, views, and datasources of one Prisma schema file. Never throws: lines it
 * can't read are listed in `errors` and skipped.
 */
export function parsePrismaSchema(text: string): PrismaSchema {
  const models: PrismaModel[] = [];
  const datasources: PrismaDatasource[] = [];
  const errors: { line: number; message: string }[] = [];
  let block:
    | { keyword: string; name: string; line: number; column: number; fields: PrismaField[] }
    | undefined;
  let provider: string | undefined;

  const close = (endLine: number): void => {
    if (!block) return;
    if (block.keyword === "model" || block.keyword === "view") {
      const { name, fields, line, column } = block;
      models.push({ name, fields, line, column, endLine });
    } else if (block.keyword === "datasource") {
      const { name, line, column } = block;
      datasources.push({ name, provider, line, column });
    }
    block = undefined;
    provider = undefined;
  };

  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const code = stripComment(raw);
    const trimmed = code.trim();
    if (trimmed === "") continue;
    const start = BLOCK_START.exec(trimmed);
    if (start) {
      if (block) {
        errors.push({ line: lineNo, message: `block "${block.name}" is missing its closing }` });
        close(lineNo - 1);
      }
      const keyword = start[1] ?? "";
      block = {
        keyword,
        name: start[2] ?? "",
        line: lineNo,
        column: code.indexOf(keyword) + 1,
        fields: [],
      };
      if (start[3] !== undefined) close(lineNo);
      continue;
    }
    if (!block) {
      errors.push({ line: lineNo, message: "unexpected text outside a block" });
      continue;
    }
    if (trimmed === "}") {
      close(lineNo);
      continue;
    }
    if (block.keyword === "model" || block.keyword === "view") {
      if (trimmed.startsWith("@@")) continue;
      const field = FIELD.exec(trimmed);
      if (!field) {
        errors.push({ line: lineNo, message: `unreadable field in ${block.name}` });
        continue;
      }
      block.fields.push({
        name: field[1] ?? "",
        type: `${field[2] ?? ""}${field[3] ?? ""}`,
        optional: field[4] === "?",
      });
    } else if (block.keyword === "datasource") {
      const match = PROVIDER.exec(trimmed);
      if (match) provider = STRING_LITERAL.exec((match[1] ?? "").trim())?.[1];
    }
  }
  if (block) {
    errors.push({ line: lines.length, message: `block "${block.name}" is missing its closing }` });
    close(lines.length);
  }
  return { models, datasources, errors };
}

/** Prisma's client accessor for a model: the name with its first letter lowercased. */
export function modelAccessor(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** The static text of a property name, or undefined for computed and private names. */
function propertyText(name: ts.PropertyName | undefined): string | undefined {
  if (!name || ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) return undefined;
  return name.text;
}

/**
 * The fields of a model a query argument names (see the file comment for which keys count),
 * sorted. Only names in `fields` are kept, so `AND`, `_count`, and typos drop out.
 */
export function namedFields(
  argument: ts.Expression | undefined,
  fields: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  const collect = (expression: ts.Expression, logical: boolean): void => {
    const e = unwrap(expression);
    if (ts.isArrayLiteralExpression(e)) {
      for (const element of e.elements) collect(element, logical);
      return;
    }
    if (ts.isStringLiteralLike(e)) {
      if (fields.has(e.text)) found.add(e.text);
      return;
    }
    if (!ts.isObjectLiteralExpression(e)) return;
    for (const property of e.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        continue;
      }
      const name = propertyText(property.name);
      if (name === undefined) continue;
      if (fields.has(name)) found.add(name);
      else if (logical && LOGICAL_KEYS.has(name) && ts.isPropertyAssignment(property)) {
        collect(property.initializer, true);
      }
    }
  };
  const top = argument && unwrap(argument);
  if (!top || !ts.isObjectLiteralExpression(top)) return [];
  for (const property of top.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyText(property.name);
    if (key === undefined || !FIELD_KEYS.has(key)) continue;
    collect(property.initializer, key === "where" || key === "having");
  }
  return [...found].sort(compareStrings);
}

/** The location of a node's first token. */
function locationOf(node: ts.Node, file: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

/** Source text with whitespace runs collapsed, cut to {@link MAX_EXPRESSION} characters. */
function expressionText(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > MAX_EXPRESSION ? `${text.slice(0, MAX_EXPRESSION - 1)}…` : text;
}

/** Where a client came from: the service that created or typed it, and how sure we are. */
interface ClientOrigin {
  service: WorkspacePackage;
  confidence: Confidence;
}

const weaker = (a: Confidence, b: Confidence): Confidence => (a === "exact" ? b : a);

/** A model a service's schema declares. */
interface ModelInfo {
  id: string;
  fields: ReadonlySet<string>;
}

/**
 * Detect Prisma schemas and client usage (see the file comment for the patterns). Reads the
 * `.prisma` files in `sourceFiles` from `root`; `inlineHandlers` comes from the Express
 * detector. Returns `model`, `datastore`, and `unresolved` nodes, `stores`/`reads`/`writes`
 * edges, and warnings, all sorted.
 */
export async function buildPrisma(
  root: string,
  programs: readonly ServiceProgram[],
  workspace: Workspace,
  resolver: SymbolResolver,
  sourceFiles: readonly string[],
  inlineHandlers: ReadonlyMap<ts.Node, readonly string[]>,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; warnings: AnalysisWarning[] }> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: AnalysisWarning[] = [];
  /** Models by accessor, per service key. */
  const models = new Map<string, Map<string, ModelInfo>>();

  // Schemas.
  const schemaFiles = sourceFiles.filter((f) => f.endsWith(".prisma"));
  /** Per service: datastores declared, and models of files without their own datasource. */
  const pending = new Map<string, { datastores: string[]; orphans: string[] }>();
  const addStores = (modelId: string, datastoreId: string): void => {
    const datastore = nodes.get(datastoreId);
    const id = edgeId("stores", modelId, datastoreId);
    edges.set(id, {
      id,
      kind: "stores",
      from: modelId,
      to: datastoreId,
      confidence: "exact",
      sites: datastore?.source ? [datastore.source] : [],
    });
  };
  for (const file of schemaFiles) {
    const service = serviceForFile(workspace, file);
    if (!service) continue;
    const schema = parsePrismaSchema(await readFile(join(root, file), "utf8"));
    const first = schema.errors[0];
    if (first) {
      const more = schema.errors.length > 1 ? ` (+${schema.errors.length - 1} more)` : "";
      warnings.push({
        code: "PRISMA_SYNTAX",
        file,
        message: `schema syntax error at line ${first.line}: ${first.message}${more}`,
      });
    }
    const byAccessor = models.get(service.key) ?? new Map<string, ModelInfo>();
    models.set(service.key, byAccessor);
    const state = pending.get(service.key) ?? { datastores: [], orphans: [] };
    pending.set(service.key, state);

    const fileModels: string[] = [];
    for (const model of schema.models) {
      const id = nodeId("model", service.key, model.name);
      const existing = nodes.get(id);
      if (existing) {
        warnings.push({
          code: "PRISMA_DUPLICATE_MODEL",
          file,
          message: `model ${model.name} is also defined in ${existing.source?.file ?? file}; keeping the first`,
        });
        continue;
      }
      nodes.set(id, {
        id,
        kind: "model",
        label: model.name,
        parentId: fileNodeId(service, file),
        layer: "data",
        fields: model.fields,
        source: { file, line: model.line, column: model.column, endLine: model.endLine },
      });
      byAccessor.set(modelAccessor(model.name), {
        id,
        fields: new Set(model.fields.map((f) => f.name)),
      });
      fileModels.push(id);
    }

    const fileStores: string[] = [];
    for (const source of schema.datasources) {
      const engine = source.provider && (ENGINES.get(source.provider) ?? source.provider);
      if (!engine) {
        warnings.push({
          code: "PRISMA_DYNAMIC_PROVIDER",
          file,
          message: `datasource ${source.name} has no string-literal provider; no datastore was created`,
        });
        continue;
      }
      const id = nodeId("datastore", "infra", `${service.key}/${file}#${source.name}`);
      nodes.set(id, {
        id,
        kind: "datastore",
        label: engine,
        parentId: SYSTEM_ID,
        layer: "data",
        engine,
        source: { file, line: source.line, column: source.column },
      });
      fileStores.push(id);
    }
    if (fileStores.length > 0) {
      for (const model of fileModels) for (const store of fileStores) addStores(model, store);
    } else {
      state.orphans.push(...fileModels);
    }
    state.datastores.push(...fileStores);
  }
  // Multi-file schemas: models in files without a datasource use the service's only one.
  for (const { datastores, orphans } of pending.values()) {
    const only = datastores.length === 1 ? datastores[0] : undefined;
    if (only !== undefined) for (const model of orphans) addStores(model, only);
  }

  const usesPrisma =
    schemaFiles.length > 0 ||
    workspace.packages.some((p) => p.dependencies.includes("@prisma/client"));
  if (usesPrisma) {
    scanClientCalls(programs, resolver, models, inlineHandlers, nodes, edges);
  }

  const sortedEdges = [...edges.values()].sort((a, b) => compareStrings(a.id, b.id));
  for (const edge of sortedEdges) {
    edge.sites.sort(
      (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
    );
    if (edge.fields) edge.fields.sort(compareStrings);
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    edges: sortedEdges,
    warnings: warnings.sort(
      (a, b) =>
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    ),
  };
}

/** Find client calls in every program and add their edges and unresolved nodes. */
function scanClientCalls(
  programs: readonly ServiceProgram[],
  resolver: SymbolResolver,
  models: ReadonlyMap<string, ReadonlyMap<string, ModelInfo>>,
  inlineHandlers: ReadonlyMap<ts.Node, readonly string[]>,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge>,
): void {
  const schemaServices = [...models.entries()].filter(([, byAccessor]) => byAccessor.size > 0);

  /** The service that owns the file a node is in, as the analyzer splits files. */
  const serviceOf = (sp: ServiceProgram, node: ts.Node): WorkspacePackage => {
    const path = sp.toRepoPath(node.getSourceFile().fileName);
    return (path === undefined ? undefined : resolver.programOf(path)?.service) ?? sp.service;
  };

  /** True when an entity or expression names `PrismaClient` or a class extending it. */
  const namesClientClass = (
    sp: ServiceProgram,
    name: ts.EntityName | ts.Expression,
    hops: number,
  ): boolean => {
    if (hops > MAX_HOPS) return false;
    const e = ts.isEntityName(name) ? name : unwrap(name);
    const last = ts.isIdentifier(e)
      ? e
      : ts.isQualifiedName(e)
        ? e.right
        : ts.isPropertyAccessExpression(e)
          ? e.name
          : undefined;
    if (!last || !ts.isIdentifier(last)) return false;
    if (last.text === "PrismaClient") return true;
    const checker = resolver.checkerOf(sp);
    let symbol = checker.getSymbolAtLocation(last);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      const declaration = symbol.declarations?.[0];
      if (
        declaration &&
        ts.isImportSpecifier(declaration) &&
        (declaration.propertyName ?? declaration.name).text === "PrismaClient"
      ) {
        return true;
      }
      symbol = checker.getAliasedSymbol(symbol);
    }
    for (const declaration of symbol?.declarations ?? []) {
      if (!ts.isClassLike(declaration)) continue;
      for (const clause of declaration.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const type of clause.types) {
          if (namesClientClass(sp, type.expression, hops + 1)) return true;
        }
      }
    }
    return false;
  };

  /** True when a type annotation is a Prisma client type. */
  const isClientType = (sp: ServiceProgram, type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    if (CLIENT_TYPE.test(type.getText())) return true;
    return ts.isTypeReferenceNode(type) && namesClientClass(sp, type.typeName, 0);
  };

  const exact = (sp: ServiceProgram, node: ts.Node): ClientOrigin => ({
    service: serviceOf(sp, node),
    confidence: "exact",
  });

  const clientOfDeclaration = (
    sp: ServiceProgram,
    declaration: ts.Declaration,
    hops: number,
  ): ClientOrigin | undefined => {
    const checker = resolver.checkerOf(sp);
    if (
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isParameter(declaration)
    ) {
      if (isClientType(sp, declaration.type)) return exact(sp, declaration);
      const init = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
      const fromInit = init && clientOf(sp, init, hops + 1);
      if (fromInit) return fromInit;
      if (ts.isParameter(declaration)) {
        // `client.$transaction(async (tx) => …)`
        const fn = declaration.parent;
        const call = fn.parent as ts.Node | undefined;
        if (
          (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
          fn.parameters[0] === declaration &&
          call &&
          ts.isCallExpression(call)
        ) {
          const callee = unwrap(call.expression);
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === "$transaction") {
            return clientOf(sp, callee.expression, hops + 1);
          }
        }
      }
      return undefined;
    }
    if (ts.isPropertyAssignment(declaration)) {
      return clientOf(sp, declaration.initializer, hops + 1);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const value = checker.getShorthandAssignmentValueSymbol(declaration);
      return value && clientOfSymbol(sp, value, hops + 1);
    }
    if (ts.isExportAssignment(declaration)) return clientOf(sp, declaration.expression, hops + 1);
    // CommonJS: `module.exports = x` and `exports.x = y` declare on the assignment.
    if (ts.isBinaryExpression(declaration)) return clientOf(sp, declaration.right, hops + 1);
    const parent = declaration.parent as ts.Node | undefined;
    if (
      ts.isPropertyAccessExpression(declaration) &&
      parent &&
      ts.isBinaryExpression(parent) &&
      parent.left === declaration
    ) {
      return clientOf(sp, parent.right, hops + 1);
    }
    return undefined;
  };

  const clientOfSymbol = (
    sp: ServiceProgram,
    start: ts.Symbol,
    hops: number,
  ): ClientOrigin | undefined => {
    if (hops > MAX_HOPS) return undefined;
    let symbol = start;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const aliased = resolver.checkerOf(sp).getAliasedSymbol(symbol);
      if ((aliased.declarations ?? []).length === 0) {
        const declaration = symbol.declarations?.[0];
        const target = declaration && resolver.importTarget(sp, declaration);
        const found = target && clientOfSymbol(target.sp, target.symbol, hops + 1);
        return found && target
          ? { service: found.service, confidence: weaker(target.confidence, found.confidence) }
          : undefined;
      }
      symbol = aliased;
    }
    for (const declaration of symbol.declarations ?? []) {
      const found = clientOfDeclaration(sp, declaration, hops);
      if (found) return found;
    }
    return undefined;
  };

  /** Where the value of an expression comes from, if it is a Prisma client. */
  const clientOf = (
    sp: ServiceProgram,
    expression: ts.Expression,
    hops: number,
  ): ClientOrigin | undefined => {
    if (hops > MAX_HOPS) return undefined;
    const e = unwrap(expression);
    const checker = resolver.checkerOf(sp);
    if (ts.isAwaitExpression(e)) return clientOf(sp, e.expression, hops + 1);
    if (ts.isNewExpression(e)) {
      return namesClientClass(sp, e.expression, hops + 1) ? exact(sp, e) : undefined;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return clientOf(sp, e.left, hops + 1) ?? clientOf(sp, e.right, hops + 1);
      }
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        return clientOf(sp, e.right, hops + 1);
      }
      return undefined;
    }
    if (ts.isConditionalExpression(e)) {
      return clientOf(sp, e.whenTrue, hops + 1) ?? clientOf(sp, e.whenFalse, hops + 1);
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "$extends") {
        return clientOf(sp, callee.expression, hops + 1);
      }
      // A factory function that returns a client.
      const name = ts.isIdentifier(callee)
        ? callee
        : ts.isPropertyAccessExpression(callee)
          ? callee.name
          : undefined;
      let symbol = name && checker.getSymbolAtLocation(name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.valueDeclaration;
      const fn =
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          ? unwrap(declaration.initializer)
          : declaration;
      if (!fn || !isFunctionWithBody(fn)) return undefined;
      for (const returned of returnedExpressions(fn)) {
        const found = clientOf(sp, returned, hops + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const symbol = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name);
      if (symbol) return clientOfSymbol(sp, symbol, hops + 1);
      // `db.prisma` where `db` is a namespace import of a workspace package.
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        const object = checker.getSymbolAtLocation(e.expression);
        const declaration = object?.declarations?.[0];
        if (declaration && ts.isNamespaceImport(declaration)) {
          const target = resolver.importTarget(sp, declaration, e.name.text);
          const found = target && clientOfSymbol(target.sp, target.symbol, hops + 1);
          return found && target
            ? { service: found.service, confidence: weaker(target.confidence, found.confidence) }
            : undefined;
        }
      }
    }
    return undefined;
  };

  /** The model a call names, or why it can't be determined. */
  const lookup = (
    accessor: string,
    origin: WorkspacePackage | undefined,
    caller: WorkspacePackage,
    confidence: Confidence,
  ): { model: ModelInfo; confidence: Confidence } | { reason: UnresolvedReason } | undefined => {
    for (const service of [origin, caller]) {
      const model = service && models.get(service.key)?.get(accessor);
      if (model) return { model, confidence };
    }
    const candidates = schemaServices.flatMap(([, byAccessor]) => {
      const model = byAccessor.get(accessor);
      return model ? [model] : [];
    });
    const only = candidates[0];
    if (candidates.length === 1 && only) {
      return { model: only, confidence: schemaServices.length === 1 ? confidence : "heuristic" };
    }
    if (candidates.length > 1) return { reason: "AMBIGUOUS" };
    return confidence === "heuristic" ? undefined : { reason: "UNKNOWN_SYMBOL" };
  };

  const addEdge = (
    kind: "reads" | "writes",
    from: string,
    to: string,
    confidence: Confidence,
    site: SourceLocation,
    fields: readonly string[],
    reason?: UnresolvedReason,
  ): void => {
    const id = edgeId(kind, from, to);
    const existing = edges.get(id);
    if (existing) {
      existing.sites.push(site);
      if (confidence === "exact") existing.confidence = "exact";
      if (fields.length > 0) {
        existing.fields = [...new Set([...(existing.fields ?? []), ...fields])];
      }
      return;
    }
    edges.set(id, {
      id,
      kind,
      from,
      to,
      confidence,
      ...(reason ? { reason } : {}),
      ...(fields.length > 0 ? { fields: [...fields] } : {}),
      sites: [site],
    });
  };

  const addUnresolved = (
    sp: ServiceProgram,
    file: string,
    site: SourceLocation,
    reason: UnresolvedReason,
    label: string,
    expression: string,
  ): string => {
    const service = sp.service;
    const id = nodeId(
      "unresolved",
      service.key,
      `${withinService(service, file)}:${site.line}:${site.column}`,
    );
    nodes.set(id, {
      id,
      kind: "unresolved",
      label,
      parentId: nodeId("service", service.key, ""),
      reason,
      expression,
      source: site,
    });
    return id;
  };

  for (const sp of programs) {
    for (const file of sp.rootFiles) {
      const sourceFile = sp.program.getSourceFile(sp.toAbsolute(file));
      const byNode = sourceFile && resolver.callers.get(sourceFile);
      if (!sourceFile || !byNode) continue;

      const handle = (
        call: ts.CallExpression | ts.TaggedTemplateExpression,
        owners: readonly string[],
      ): void => {
        const callee = unwrap(ts.isCallExpression(call) ? call.expression : call.tag);
        if (!ts.isPropertyAccessExpression(callee)) return;
        const op = callee.name.text;
        const site = locationOf(callee.name, file);

        const raw = RAW_OPS.get(op);
        if (raw) {
          if (!clientOf(sp, callee.expression, 0)) return;
          const id = addUnresolved(
            sp,
            file,
            site,
            "RAW_QUERY",
            callee.getText(),
            expressionText(call),
          );
          for (const owner of owners) addEdge(raw, owner, id, "unresolved", site, [], "RAW_QUERY");
          return;
        }
        const kind = READ_OPS.has(op) ? "reads" : WRITE_OPS.has(op) ? "writes" : undefined;
        if (!kind || !ts.isCallExpression(call)) return;
        const delegate = unwrap(callee.expression);
        if (!ts.isPropertyAccessExpression(delegate)) return;
        const accessor = delegate.name.text;
        if (accessor.startsWith("$")) return;
        const receiver = unwrap(delegate.expression);
        const origin = clientOf(sp, receiver, 0);
        if (!origin) {
          const name = ts.isIdentifier(receiver)
            ? receiver.text
            : ts.isPropertyAccessExpression(receiver)
              ? receiver.name.text
              : undefined;
          if (name === undefined || !CLIENT_NAME.test(name)) return;
        }
        const found = lookup(
          accessor,
          origin?.service,
          sp.service,
          origin?.confidence ?? "heuristic",
        );
        if (!found) return;
        if ("reason" in found) {
          const text = `${receiver.getText()}.${accessor}.${op}`;
          const id = addUnresolved(sp, file, site, found.reason, text, text);
          for (const owner of owners)
            addEdge(kind, owner, id, "unresolved", site, [], found.reason);
          return;
        }
        const fields = namedFields(call.arguments[0], found.model.fields);
        for (const owner of owners) {
          addEdge(kind, owner, found.model.id, found.confidence, site, fields);
        }
      };

      const visit = (node: ts.Node, owners: readonly string[]): void => {
        const symbol = byNode.get(node);
        const current = inlineHandlers.get(node) ?? (symbol !== undefined ? [symbol] : owners);
        if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) handle(node, current);
        ts.forEachChild(node, (child) => {
          visit(child, current);
        });
      };
      visit(sourceFile, []);
    }
  }
}
