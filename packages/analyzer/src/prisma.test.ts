import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareStrings, type ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { createSymbolResolver } from "./calls.js";
import { buildExpressRoutes } from "./express.js";
import { buildInventory } from "./inventory.js";
import {
  buildPrismaSchemas,
  collectPrismaFacts,
  composePrisma,
  fieldUse,
  modelAccessor,
  parsePrismaSchema,
  type PrismaFacts,
  type PrismaPart,
} from "./prisma.js";
import { buildServicePrograms } from "./program.js";
import { detectWorkspace } from "./workspace.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-prisma-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string | string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), Array.isArray(content) ? content.join("\n") + "\n" : content);
}

async function app(name = "api", extra: Record<string, string> = {}): Promise<void> {
  await put(
    "package.json",
    JSON.stringify({ name, dependencies: { "@prisma/client": "6", ...extra } }),
  );
}

const SCHEMA = [
  "datasource db {",
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL")',
  "}",
  "",
  "model User {",
  "  id    Int     @id @default(autoincrement())",
  "  email String  @unique",
  "  name  String?",
  "  posts Post[]",
  "}",
  "",
  "model Post {",
  "  id       Int    @id",
  "  title    String",
  "  author   User   @relation(fields: [authorId], references: [id])",
  "  authorId Int",
  "}",
];

/** `kind from -> to (confidence) [fields]` for each reads/writes edge, sorted. */
function usage(graph: ArchitectureGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === "reads" || e.kind === "writes")
    .map(
      (e) =>
        `${e.kind} ${e.from} -> ${e.to} (${e.confidence})` +
        (e.fields ? ` [${e.fields.join(",")}]` : ""),
    )
    .sort(compareStrings);
}

function unresolved(graph: ArchitectureGraph): string[] {
  return graph.nodes.flatMap((n) =>
    n.kind === "unresolved" ? [`${n.id} ${n.reason} ${n.expression}`] : [],
  );
}

function prismaWarnings(graph: ArchitectureGraph): string[] {
  return graph.warnings
    .filter((w) => w.code.startsWith("PRISMA"))
    .map((w) => `${w.code} ${w.file ?? ""}`);
}

describe("parsePrismaSchema", () => {
  it("reads models, fields, views, and datasources", () => {
    const schema = parsePrismaSchema(
      [
        "// a comment",
        "generator client {",
        '  provider = "prisma-client-js"',
        "}",
        "datasource db {",
        '  provider = "mysql" // trailing',
        "}",
        "enum Role {",
        "  USER",
        "  ADMIN",
        "}",
        "model Doc {",
        '  id    String @id @default("a//b") // not a comment inside the string',
        "  tags  String[]",
        '  body  Unsupported("tsvector")?',
        "  role  Role?@default(USER)",
        "  @@index([id])",
        "}",
        "view Summary {",
        "  total Int",
        "}",
        "model Empty {}",
      ].join("\r\n"),
    );
    expect(schema.errors).toEqual([]);
    expect(schema.datasources).toEqual([{ name: "db", provider: "mysql", line: 5, column: 1 }]);
    expect(schema.models).toEqual([
      {
        name: "Doc",
        line: 12,
        column: 1,
        endLine: 18,
        fields: [
          { name: "id", type: "String", optional: false },
          { name: "tags", type: "String[]", optional: false },
          { name: "body", type: 'Unsupported("tsvector")', optional: true },
          { name: "role", type: "Role", optional: true },
        ],
      },
      {
        name: "Summary",
        line: 19,
        column: 1,
        endLine: 21,
        fields: [{ name: "total", type: "Int", optional: false }],
      },
      { name: "Empty", line: 22, column: 1, endLine: 22, fields: [] },
    ]);
  });

  it("leaves a non-literal provider undefined", () => {
    const schema = parsePrismaSchema(["datasource db {", '  provider = env("P")', "}"].join("\n"));
    expect(schema.datasources).toEqual([{ name: "db", provider: undefined, line: 1, column: 1 }]);
  });

  it("records lines it can't read and unterminated blocks", () => {
    const schema = parsePrismaSchema(
      ["stray", "model A {", "  ???", "model B {", "  id Int", ""].join("\n"),
    );
    expect(schema.errors).toEqual([
      { line: 1, message: "unexpected text outside a block" },
      { line: 3, message: "unreadable field in A" },
      { line: 4, message: 'block "A" is missing its closing }' },
      { line: 6, message: 'block "B" is missing its closing }' },
    ]);
    expect(schema.models.map((m) => [m.name, m.endLine])).toEqual([
      ["A", 3],
      ["B", 6],
    ]);
  });
});

describe("modelAccessor", () => {
  it.each([
    ["User", "user"],
    ["OrderItem", "orderItem"],
    ["URL", "uRL"],
  ])("maps %s to %s", (name, accessor) => {
    expect(modelAccessor(name)).toBe(accessor);
  });
});

describe("fieldUse", () => {
  const argument = (code: string): ts.Expression => {
    const sourceFile = ts.createSourceFile("a.ts", `f(${code})`, ts.ScriptTarget.ES2022, true);
    const statement = sourceFile.statements[0] as ts.ExpressionStatement;
    return (statement.expression as ts.CallExpression).arguments[0] as ts.Expression;
  };
  const fields = new Set(["id", "email", "name", "posts", "createdAt"]);

  it.each([
    ["{ where: { email: x }, select: { id: true, _count: true } }", ["email", "id"]],
    [
      "{ where: { OR: [{ name: a }, { NOT: { email: b } }], AND: { id: 1 } } }",
      ["email", "id", "name"],
    ],
    ['{ orderBy: [{ createdAt: "desc" }], distinct: ["name"] }', ["createdAt", "name"]],
    ['{ by: ["email"], _max: { id: true } }', ["email", "id"]],
    ["{ data: [{ email }, { name: n }] }", ["email", "name"]],
    [
      "{ create: { email: e }, update: { name: n }, include: { posts: true } }",
      ["email", "name", "posts"],
    ],
    ["{ select: { OR: true }, other: { id: true }, ...rest }", []],
    ["{ [key]: { id: true } }", []],
    ["args", []],
  ])("finds the fields %s names", (code, expected) => {
    expect(fieldUse(argument(code), fields)).toEqual({ named: expected, missing: [] });
  });

  it.each([
    ["{ where: { nickname: x, email: y } }", ["email"], ["nickname"]],
    ['{ distinct: ["nmae"], orderBy: { age: "asc" } }', [], ["age", "nmae"]],
    [
      "{ where: { OR: [{ nickname: a }] }, data: { status }, other: { gone: 1 } }",
      [],
      ["nickname", "status"],
    ],
    ["{ where: { email_name: { email: e, name: n } } }", [], []],
    ["{ where: { email_tenant: x } }", [], ["email_tenant"]],
    ["{ select: { _count: { select: { posts: true } } }, _sum: { _all: true } }", [], []],
  ])("keeps the names %s uses that the model lacks", (code, named, missing) => {
    expect(fieldUse(argument(code), fields)).toEqual({ named, missing });
  });

  it("returns nothing without an argument", () => {
    expect(fieldUse(undefined, fields)).toEqual({ named: [], missing: [] });
  });
});

describe("prisma facts", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

  /** The schemas, every service's client-call facts, and Express's inline handlers. */
  async function prismaInputs(root: string) {
    const inventory = await buildInventory(root);
    const workspace = await detectWorkspace(root, inventory.files);
    const programs = buildServicePrograms(root, workspace, inventory);
    const resolver = createSymbolResolver(programs, workspace);
    const { inlineHandlers } = buildExpressRoutes(programs, resolver);
    const schemas = await buildPrismaSchemas(root, workspace, inventory.sourceFiles);
    const facts = programs.map((sp) => collectPrismaFacts(sp, resolver, schemas.usesPrisma));
    return { schemas, facts, inlineHandlers };
  }

  /** Client usage in `analyze`'s graph: reads/writes edges and the unresolved nodes they reach. */
  function clientPart(graph: ArchitectureGraph) {
    const edges = graph.edges.filter((e) => e.kind === "reads" || e.kind === "writes");
    const targets = new Set(edges.map((e) => e.to));
    return {
      edges,
      unresolved: graph.nodes.filter((n) => n.kind === "unresolved" && targets.has(n.id)),
      models: graph.nodes.filter((n) => n.kind === "model"),
    };
  }

  function composedClientPart(part: PrismaPart) {
    const edges = part.edges.filter((e) => e.kind === "reads" || e.kind === "writes");
    return {
      edges,
      unresolved: part.nodes.filter((n) => n.kind === "unresolved"),
      models: part.nodes.filter((n) => n.kind === "model"),
    };
  }

  it.each(["prisma-relations", "shop-demo", "diff-broken-head"])(
    "composes %s from JSON round-tripped facts exactly as analyze does",
    async (name) => {
      const root = join(FIXTURES, name);
      const { schemas, facts, inlineHandlers } = await prismaInputs(root);
      const revived = JSON.parse(JSON.stringify(facts)) as PrismaFacts[];
      expect(revived).toEqual(facts);
      const composed = composePrisma(schemas, revived, inlineHandlers);
      const graph = await analyze(root);
      expect(composed.edges.some((e) => e.kind === "reads" || e.kind === "writes")).toBe(true);
      expect(composedClientPart(composed)).toEqual(clientPart(graph));
      expect(composed.warnings).toEqual(graph.warnings.filter((w) => w.code.startsWith("PRISMA")));
    },
  );

  async function clientRepo(): Promise<void> {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    await put(
      "packages/db/package.json",
      JSON.stringify({ name: "@acme/db", dependencies: { "@prisma/client": "6" } }),
    );
    await put("packages/db/prisma/schema.prisma", SCHEMA);
    await put("packages/db/src/index.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "export const prisma = new PrismaClient();",
      "export function byId(id: number) { return prisma.user.findUnique({ where: { id } }); }",
    ]);
    await put(
      "apps/api/package.json",
      JSON.stringify({ name: "api", dependencies: { "@acme/db": "workspace:*" } }),
    );
    await put("apps/api/src/users.ts", [
      'import { prisma } from "@acme/db";',
      "export function find(email: string) {",
      "  return prisma.user.findMany({ where: { email }, select: { id: true } });",
      "}",
      "export function raw() { return prisma.$queryRaw`SELECT 1`; }",
    ]);
  }

  const of = (all: PrismaFacts[], service: string) => all.find((f) => f.service === service);

  it("keeps a service's client facts unchanged when the schema loses a field it uses", async () => {
    await clientRepo();
    const before = await prismaInputs(dir);
    await put(
      "packages/db/prisma/schema.prisma",
      SCHEMA.filter((line) => !line.includes("email")),
    );
    const after = await prismaInputs(dir);
    expect(of(after.facts, "api")).toEqual(of(before.facts, "api"));
    expect(of(after.facts, "api")?.calls.map((c) => c.type)).toEqual(["model", "raw"]);
    const sitesOf = (part: PrismaPart) =>
      part.edges.find((e) => e.id === "reads:symbol:api/src/users.ts#find->model:db/User")?.sites;
    const composed = composePrisma(after.schemas, after.facts, after.inlineHandlers);
    expect(sitesOf(composed)?.map((s) => s.missingFields)).toEqual([["email"]]);
    expect(
      sitesOf(composePrisma(before.schemas, before.facts, before.inlineHandlers))?.map(
        (s) => s.missingFields,
      ),
    ).toEqual([undefined]);
    expect(composedClientPart(composed)).toEqual(clientPart(await analyze(dir)));
  });

  it("keeps the client's package facts unchanged when another service starts calling it", async () => {
    await clientRepo();
    const before = await prismaInputs(dir);
    await put("apps/api/src/posts.ts", [
      'import { prisma } from "@acme/db";',
      "export const posts = () => prisma.post.findMany();",
    ]);
    const after = await prismaInputs(dir);
    expect(of(before.facts, "db")?.calls).toHaveLength(1);
    expect(of(after.facts, "db")).toEqual(of(before.facts, "db"));
    expect(of(after.facts, "api")).not.toEqual(of(before.facts, "api"));
  });

  it("looks for nothing in a repo without Prisma, and composes unscanned facts to nothing", async () => {
    await put("package.json", JSON.stringify({ name: "api" }));
    await put(
      "src/db.ts",
      "declare const db: any;\nexport const all = () => db.user.findMany();\n",
    );
    const { schemas, facts, inlineHandlers } = await prismaInputs(dir);
    expect(schemas.usesPrisma).toBe(false);
    expect(facts).toEqual([{ service: "api", scanned: false, calls: [] }]);
    const unscanned: PrismaFacts = {
      ...(facts[0] as PrismaFacts),
      calls: [
        {
          type: "raw",
          kind: "reads",
          owners: { handlers: [], ids: ["symbol:api/src/db.ts#all"] },
          site: { file: "src/db.ts", line: 2, column: 1 },
          node: { id: "unresolved:api/src/db.ts:2:1", label: "db.$queryRaw", expression: "x" },
        },
      ],
    };
    expect(composePrisma(schemas, [unscanned], inlineHandlers)).toEqual({
      nodes: [],
      edges: [],
      warnings: [],
      datastores: [],
    });
  });
});

describe("buildPrisma via analyze", () => {
  it("emits models, the datastore, stores edges, and exact client usage with fields", async () => {
    await app();
    await put("prisma/schema.prisma", SCHEMA);
    await put("src/db.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "export const prisma = new PrismaClient();",
    ]);
    await put("src/users.ts", [
      'import { prisma } from "./db";',
      "export async function listUsers(email: string) {",
      "  return prisma.user.findMany({ where: { email }, select: { id: true, name: true } });",
      "}",
      "export async function addPost(title: string) {",
      "  await prisma.post.create({ data: { title, authorId: 1 } });",
      "  await prisma.post.create({ data: { title } });",
      "  return prisma.user.count();",
      "}",
    ]);
    const graph = await analyze(dir);

    const user = graph.nodes.find((n) => n.id === "model:api/User");
    expect(user).toEqual({
      id: "model:api/User",
      kind: "model",
      label: "User",
      parentId: "file:api/prisma/schema.prisma",
      layer: "data",
      fields: [
        { name: "id", type: "Int", optional: false },
        { name: "email", type: "String", optional: false },
        { name: "name", type: "String", optional: true },
        { name: "posts", type: "Post[]", optional: false },
      ],
      source: { file: "prisma/schema.prisma", line: 6, column: 1, endLine: 11 },
    });
    const store = "datastore:infra/api/prisma/schema.prisma#db";
    expect(graph.nodes.find((n) => n.id === store)).toMatchObject({
      kind: "datastore",
      engine: "postgres",
      label: "postgres",
      parentId: "system:root",
    });
    expect(graph.edges.filter((e) => e.kind === "stores").map((e) => e.id)).toEqual([
      `stores:model:api/Post->${store}`,
      `stores:model:api/User->${store}`,
    ]);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/users.ts#addPost -> model:api/User (exact)",
      "reads symbol:api/src/users.ts#listUsers -> model:api/User (exact) [email,id,name]",
      "writes symbol:api/src/users.ts#addPost -> model:api/Post (exact) [authorId,title]",
    ]);
    const writes = graph.edges.find((e) => e.kind === "writes");
    expect(writes?.sites).toEqual([
      { file: "src/users.ts", line: 6, column: 21 },
      { file: "src/users.ts", line: 7, column: 21 },
    ]);
  });

  it("traces the globalThis singleton, default exports, $extends, factories, and CommonJS", async () => {
    await app();
    await put("schema.prisma", SCHEMA);
    await put("lib/global.ts", [
      'import { PrismaClient as PC } from "@prisma/client";',
      "const g = globalThis as unknown as { cached: PC | undefined };",
      "const client = g.cached ?? new PC();",
      "export default client;",
    ]);
    await put("lib/extended.ts", [
      'import * as runtime from "@prisma/client";',
      "export const xdb = new runtime.PrismaClient().$extends({});",
    ]);
    await put("lib/factory.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "export function makeClient() { return new PrismaClient(); }",
      "export const makeArrow = () => new PrismaClient();",
    ]);
    await put("lib/cjs.js", [
      'const { PrismaClient } = require("@prisma/client");',
      "module.exports = new PrismaClient();",
    ]);
    await put("src/use.ts", [
      'import client from "../lib/global";',
      'import { xdb } from "../lib/extended";',
      'import { makeClient, makeArrow } from "../lib/factory";',
      "export async function a() { return client.user.findUnique({ where: { id: 1 } }); }",
      "export async function b() { return xdb.post.deleteMany(); }",
      "export async function c() { const local = makeClient(); return local.user.upsert({}); }",
      "export async function d() { const s = await makeArrow(); return s.post.groupBy({ by: ['title'] }); }",
    ]);
    await put("src/use-cjs.js", [
      'const store = require("../lib/cjs");',
      "async function e() { return store.user.findFirst(); }",
      "module.exports = { e };",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/use-cjs.js#e -> model:api/User (exact)",
      "reads symbol:api/src/use.ts#a -> model:api/User (exact) [id]",
      "reads symbol:api/src/use.ts#d -> model:api/Post (exact) [title]",
      "writes symbol:api/src/use.ts#b -> model:api/Post (exact)",
      "writes symbol:api/src/use.ts#c -> model:api/User (exact)",
    ]);
  });

  it("attributes calls in inline Express handlers to their routes", async () => {
    await app("api", { express: "4" });
    await put("schema.prisma", SCHEMA);
    await put("src/server.ts", [
      'import express from "express";',
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      "const app = express();",
      "const wrap = (fn: unknown) => fn;",
      'app.get("/users", async (req, res) => { res.json(await prisma.user.findMany()); });',
      'app.post("/posts", wrap(async (req, res) => { await prisma.post.create({ data: { title: "t" } }); }));',
      "prisma.user.count();",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads route:api/GET /users -> model:api/User (exact)",
      "writes route:api/POST /posts -> model:api/Post (exact) [title]",
    ]);
  });

  it("handles $transaction callbacks, typed clients, and classes extending PrismaClient", async () => {
    await app();
    await put("schema.prisma", SCHEMA);
    await put("src/service.ts", [
      'import { PrismaClient, Prisma } from "@prisma/client";',
      "export class PrismaService extends PrismaClient {}",
      "export class Users {",
      "  constructor(private readonly db: PrismaService) {}",
      "  all() { return this.db.user.findMany(); }",
      "}",
      "export async function move(client: PrismaClient) {",
      "  await client.$transaction(async (t) => { await t.post.update({ where: { id: 1 }, data: {} }); });",
      "}",
      "export async function inTx(t2: Prisma.TransactionClient) { return t2.user.delete({ where: { id: 1 } }); }",
      "export function fresh() { return new PrismaService().post.findMany(); }",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/service.ts#Users.all -> model:api/User (exact)",
      "reads symbol:api/src/service.ts#fresh -> model:api/Post (exact)",
      "writes symbol:api/src/service.ts#inTx -> model:api/User (exact) [id]",
      "writes symbol:api/src/service.ts#move -> model:api/Post (exact) [id]",
    ]);
  });

  it("records raw queries as unresolved nodes, with an edge only when there is a caller", async () => {
    await app();
    await put("schema.prisma", SCHEMA);
    await put("src/raw.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      "export async function report() {",
      "  return prisma.$queryRaw`SELECT * FROM users`;",
      "}",
      "export async function wipe() { return prisma.$executeRawUnsafe('DELETE FROM posts'); }",
      "prisma.$queryRaw`SELECT 1`;",
      "other.$queryRaw`SELECT 2`;",
    ]);
    const graph = await analyze(dir);
    expect(unresolved(graph).sort(compareStrings)).toEqual([
      "unresolved:api/src/raw.ts:4:17 RAW_QUERY prisma.$queryRaw`SELECT * FROM users`",
      "unresolved:api/src/raw.ts:6:46 RAW_QUERY prisma.$executeRawUnsafe('DELETE FROM posts')",
      "unresolved:api/src/raw.ts:7:8 RAW_QUERY prisma.$queryRaw`SELECT 1`",
    ]);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/raw.ts#report -> unresolved:api/src/raw.ts:4:17 (unresolved)",
      "writes symbol:api/src/raw.ts#wipe -> unresolved:api/src/raw.ts:6:46 (unresolved)",
    ]);
    expect(graph.edges.find((e) => e.kind === "reads")?.reason).toBe("RAW_QUERY");
  });

  it("cuts long raw-query expressions", async () => {
    await app();
    await put("src/raw.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      `export const q = () => prisma.$queryRawUnsafe("${"x".repeat(200)}");`,
    ]);
    const graph = await analyze(dir);
    const node = graph.nodes.find((n) => n.kind === "unresolved");
    expect(node?.kind === "unresolved" && node.expression.length).toBe(120);
    expect(node?.kind === "unresolved" && node.expression.endsWith("…")).toBe(true);
  });

  it("uses name heuristics only for untraced receivers that look like clients", async () => {
    await app();
    await put("schema.prisma", SCHEMA);
    await put("src/trpc.ts", [
      "export async function list(ctx: any) { return ctx.db.user.findMany(); }",
      "export async function viaTx(tx: any) { return tx.post.create({}); }",
      "export async function notPrisma(cache: any) { return cache.user.findMany(); }",
      "export async function notModel(db: any) { return db.comment.findMany(); }",
      "export async function notOp(db: any) { return db.user.findAll(); }",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/trpc.ts#list -> model:api/User (heuristic)",
      "writes symbol:api/src/trpc.ts#viaTx -> model:api/Post (heuristic)",
    ]);
    expect(unresolved(graph)).toEqual([]);
  });

  it("makes a traced call to an unknown model an UNKNOWN_SYMBOL node", async () => {
    await app();
    await put("schema.prisma", SCHEMA);
    await put("src/a.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      "export function f() { return prisma.comment.findMany(); }",
      "export function g() { return prisma.$transaction([]); }",
    ]);
    const graph = await analyze(dir);
    expect(unresolved(graph)).toEqual([
      "unresolved:api/src/a.ts:3:45 UNKNOWN_SYMBOL prisma.comment.findMany",
    ]);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/a.ts#f -> unresolved:api/src/a.ts:3:45 (unresolved)",
    ]);
  });

  it("follows a client exported by another workspace package to its schema", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await put(
      "packages/db/package.json",
      JSON.stringify({
        name: "@acme/db",
        main: "src/index.ts",
        dependencies: { "@prisma/client": "6" },
      }),
    );
    await put("packages/db/prisma/schema.prisma", SCHEMA);
    await put("packages/db/src/index.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "export const prisma = new PrismaClient();",
    ]);
    await put(
      "apps/api/package.json",
      JSON.stringify({ name: "api", dependencies: { "@acme/db": "workspace:*" } }),
    );
    await put("apps/api/src/handler.ts", [
      'import { prisma } from "@acme/db";',
      'import * as db from "@acme/db";',
      "export function one() { return prisma.user.findMany(); }",
      "export function two() { return db.prisma.post.create({ data: { title: 'x' } }); }",
      "export function three(client: import('@prisma/client').PrismaClient) { return client.user.count(); }",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads symbol:api/src/handler.ts#one -> model:db/User (exact)",
      "reads symbol:api/src/handler.ts#three -> model:db/User (exact)",
      "writes symbol:api/src/handler.ts#two -> model:db/Post (exact) [title]",
    ]);
  });

  it("marks models found in one of several schemas heuristic, and several candidates AMBIGUOUS", async () => {
    await put(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
    );
    await put("apps/a/package.json", JSON.stringify({ name: "a" }));
    await put("apps/a/schema.prisma", [
      "model User {",
      "  id Int",
      "}",
      "model Only {",
      "  id Int",
      "}",
    ]);
    await put("apps/b/package.json", JSON.stringify({ name: "b" }));
    await put("apps/b/schema.prisma", ["model User {", "  id Int", "}"]);
    await put("apps/c/package.json", JSON.stringify({ name: "c" }));
    await put("apps/c/src/x.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      "export function f() { return prisma.user.findMany(); }",
      "export function g() { return prisma.only.findMany({ where: { id: 1 } }); }",
    ]);
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([
      "reads symbol:c/src/x.ts#f -> unresolved:c/src/x.ts:3:42 (unresolved)",
      "reads symbol:c/src/x.ts#g -> model:a/Only (heuristic) [id]",
    ]);
    expect(unresolved(graph)).toEqual([
      "unresolved:c/src/x.ts:3:42 AMBIGUOUS prisma.user.findMany",
    ]);
    expect(graph.nodes.some((n) => n.kind === "datastore")).toBe(false);
  });

  it("links multi-file schema models to the service's one datasource and warns on problems", async () => {
    await app();
    await put("prisma/schema/base.prisma", [
      "datasource db {",
      '  provider = "mongodb"',
      "}",
      "model User {",
      "  id String",
      "}",
    ]);
    await put("prisma/schema/post.prisma", [
      "model Post {",
      "  id String",
      "}",
      "model User {",
      "  id String",
      "}",
    ]);
    await put("prisma/other/legacy.prisma", [
      "datasource old {",
      '  provider = env("P")',
      "}",
      "oops",
    ]);
    const graph = await analyze(dir);
    const store = "datastore:infra/api/prisma/schema/base.prisma#db";
    expect(graph.edges.filter((e) => e.kind === "stores").map((e) => e.id)).toEqual([
      `stores:model:api/Post->${store}`,
      `stores:model:api/User->${store}`,
    ]);
    expect(graph.nodes.find((n) => n.id === store)).toMatchObject({ engine: "mongo" });
    expect(prismaWarnings(graph)).toEqual([
      "PRISMA_DYNAMIC_PROVIDER prisma/other/legacy.prisma",
      "PRISMA_SYNTAX prisma/other/legacy.prisma",
      "PRISMA_DUPLICATE_MODEL prisma/schema/post.prisma",
    ]);
    expect(graph.warnings.find((w) => w.code === "PRISMA_SYNTAX")?.message).toBe(
      "schema syntax error at line 4: unexpected text outside a block",
    );
  });

  it("warns instead of guessing when a datasource-less schema file has no single fallback", async () => {
    await app();
    await put("prisma/a.prisma", ["datasource a {", '  provider = "postgresql"', "}"]);
    await put("prisma/b.prisma", ["datasource b {", '  provider = "mysql"', "}"]);
    await put("prisma/models.prisma", [
      "model Post {",
      "  id Int",
      "}",
      "model Tag {",
      "  id Int",
      "}",
    ]);
    const graph = await analyze(dir);
    expect(graph.edges.filter((e) => e.kind === "stores")).toEqual([]);
    expect(graph.warnings.filter((w) => w.code === "PRISMA_NO_DATASOURCE")).toEqual([
      {
        code: "PRISMA_NO_DATASOURCE",
        file: "prisma/models.prisma",
        message:
          "2 models in prisma/models.prisma have no datastore: the schema file declares no datasource and the service has 2 to fall back on",
      },
    ]);
  });

  it("does nothing for repos without Prisma", async () => {
    await put("package.json", JSON.stringify({ name: "plain" }));
    await put("src/a.ts", "export function f(db: any) { return db.user.findMany(); }\n");
    const graph = await analyze(dir);
    expect(usage(graph)).toEqual([]);
    expect(graph.nodes.filter((n) => n.kind === "model" || n.kind === "unresolved")).toEqual([]);
  });

  it("is deterministic", async () => {
    await app("api", { express: "4" });
    await put("schema.prisma", SCHEMA);
    await put("src/a.ts", [
      'import { PrismaClient } from "@prisma/client";',
      "const prisma = new PrismaClient();",
      "export function f() { prisma.user.findMany({ select: { name: true } }); return prisma.user.findMany({ where: { id: 1 } }); }",
    ]);
    const first = await analyze(dir);
    const second = await analyze(dir);
    expect(second).toEqual(first);
    expect(usage(first)).toEqual([
      "reads symbol:api/src/a.ts#f -> model:api/User (exact) [id,name]",
    ]);
  });
});
