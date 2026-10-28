import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareStrings, stringifyGraph, type ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { imageEngine, parseCompose, parseEnv, relinkStores, urlAuthority } from "./infra.js";
import { parsePrismaSchema } from "./prisma.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-infra-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string[]): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content.join("\n") + "\n");
}

async function prismaApp(datasource: string[] = ['  url = env("DATABASE_URL")']): Promise<void> {
  await put("package.json", [JSON.stringify({ name: "api" })]);
  await put("prisma/schema.prisma", [
    "datasource db {",
    '  provider = "postgresql"',
    ...datasource,
    "}",
    "model User {",
    "  id Int @id",
    "}",
  ]);
}

/** `id engine (source file:line)` for each datastore and queue node, sorted. */
function infraNodes(graph: ArchitectureGraph): string[] {
  return graph.nodes
    .flatMap((n) =>
      n.kind === "datastore" || n.kind === "queue"
        ? [`${n.id} ${n.engine} ${n.label} (${n.source?.file ?? ""}:${n.source?.line ?? 0})`]
        : [],
    )
    .sort(compareStrings);
}

/** `from -> to (confidence)` for each stores edge, sorted. */
function stores(graph: ArchitectureGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === "stores")
    .map((e) => `${e.from} -> ${e.to} (${e.confidence})`)
    .sort(compareStrings);
}

function infraWarnings(graph: ArchitectureGraph): string[] {
  return graph.warnings
    .filter((w) => w.code.startsWith("COMPOSE") || w.code.startsWith("INFRA"))
    .map((w) => `${w.code} ${w.file ?? ""}: ${w.message}`);
}

describe("urlAuthority", () => {
  it.each([
    [
      "postgresql://user:pw@db:5432/app?schema=public",
      { scheme: "postgresql", host: "db", port: 5432 },
    ],
    [
      "  REDISS://:p@ss@Cache.Example.com:6380 ",
      { scheme: "rediss", host: "cache.example.com", port: 6380 },
    ],
    [
      "mongodb+srv://u:p@cluster0.mongodb.net/db",
      { scheme: "mongodb+srv", host: "cluster0.mongodb.net" },
    ],
    ["postgres://[::1]:5433/x", { scheme: "postgres", host: "::1", port: 5433 }],
    ["mongodb://h1:27017,h2:27017/db", { scheme: "mongodb" }],
    ["postgres://u:p@${DB_HOST}:5432/db", { scheme: "postgres" }],
    ["amqp://", { scheme: "amqp" }],
  ])("reads %s", (value, expected) => {
    expect(urlAuthority(value)).toEqual(expected);
  });

  it.each(["file:./dev.db", "sk_live_123", "", "localhost:5432"])("ignores %s", (value) => {
    expect(urlAuthority(value)).toBeUndefined();
  });
});

describe("parseEnv", () => {
  it("keeps keys and URL authorities, never values", () => {
    const entries = parseEnv(
      [
        "# comment",
        "DATABASE_URL=postgresql://user:hunter2@db:5432/app # local",
        'export REDIS_URL="redis://localhost:6379"',
        "  API_KEY = 'sk_live_planted'",
        'PRIVATE_KEY="-----BEGIN KEY-----',
        "NOT_A_KEY=redis://inside-the-key:1",
        '-----END KEY-----"',
        "AFTER=amqp://mq",
        "not a line",
      ].join("\r\n"),
    );
    expect(entries).toEqual([
      {
        key: "DATABASE_URL",
        line: 2,
        column: 1,
        url: { scheme: "postgresql", host: "db", port: 5432 },
      },
      {
        key: "REDIS_URL",
        line: 3,
        column: 8,
        url: { scheme: "redis", host: "localhost", port: 6379 },
      },
      { key: "API_KEY", line: 4, column: 3 },
      { key: "PRIVATE_KEY", line: 5, column: 1 },
      { key: "AFTER", line: 8, column: 1, url: { scheme: "amqp", host: "mq" } },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/hunter2|sk_live|BEGIN/);
  });

  it("reads the lines after a quote that never closes (M2 review)", () => {
    const entries = parseEnv(
      ['A="unterminated', "DATABASE_URL=postgres://db:5432/x", "B='ok'"].join("\n"),
    );
    expect(entries).toEqual([
      { key: "A", line: 1, column: 1 },
      {
        key: "DATABASE_URL",
        line: 2,
        column: 1,
        url: { scheme: "postgres", host: "db", port: 5432 },
      },
      { key: "B", line: 3, column: 1 },
    ]);
  });

  it("stays linear on many unterminated quotes", () => {
    // Every line opens a quote that the next line's quote closes, so every other line is a
    // key; the last one never closes and is read as a one-line value.
    const text = Array.from({ length: 100_000 }, (_, i) => `K${i}="x`).join("\n");
    const started = performance.now();
    expect(parseEnv(text)).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("imageEngine", () => {
  it.each([
    ["postgres", "postgres"],
    ["postgres:16-alpine", "postgres"],
    ["docker.io/bitnami/postgresql@sha256:abc", "postgres"],
    ["postgis/postgis:15-3.4", "postgres"],
    ["library/mariadb:11", "mysql"],
    ["localhost:5000/redis:7", "redis"],
    ["valkey/valkey", "redis"],
    ["mcr.microsoft.com/mssql/server:2022-latest", "sqlserver"],
    ["rabbitmq:3-management", "rabbitmq"],
    ["confluentinc/cp-kafka:7.5.0", "kafka"],
    ["MONGO", "mongo"],
  ])("%s ⇒ %s", (image, engine) => {
    expect(imageEngine(image)).toBe(engine);
  });

  it.each(["node:20", "nginx", "acme/api", "server"])("doesn't know %s", (image) => {
    expect(imageEngine(image)).toBeUndefined();
  });
});

describe("parseCompose", () => {
  it("reads services with host names, ports, anchors, and merge keys", () => {
    const { services, error } = parseCompose(
      [
        "x-db: &db",
        "  image: postgres:16",
        "  ports: ['127.0.0.1:5450:5432/tcp']",
        "services:",
        "  db:",
        "    <<: *db",
        "    container_name: Shop-DB",
        "    networks:",
        "      back:",
        "        aliases: [database]",
        "      front: {}",
        "  cache:",
        "    image: redis",
        "    ports:",
        "      - 6379",
        "      - '6380:6379'",
        "      - target: 6379",
        "        published: '6381'",
        "      - '7000-7001:7000-7001'",
        "      - '${PORT}:6379'",
        "  web:",
        "    build: .",
        "  broken: 3",
      ].join("\n"),
    );
    expect(error).toBeUndefined();
    expect(services).toEqual([
      {
        name: "cache",
        line: 12,
        column: 3,
        image: "redis",
        hostnames: ["cache"],
        ports: [6380, 6381],
      },
      {
        name: "db",
        line: 5,
        column: 3,
        image: "postgres:16",
        hostnames: ["database", "db", "shop-db"],
        ports: [5450],
      },
      { name: "web", line: 21, column: 3, hostnames: ["web"], ports: [] },
    ]);
  });

  it("returns nothing for files without services", () => {
    expect(parseCompose("version: '3'\n")).toEqual({ services: [] });
    expect(parseCompose("services: [a]\n")).toEqual({ services: [] });
  });

  it("reports invalid YAML by line, without its text", () => {
    const result = parseCompose(
      "services:\n  db:\n    image: postgres\n  db:\n    image: s3cr3t\n",
    );
    expect(result.services).toEqual([]);
    expect(result.error).toMatch(/^could not parse YAML at line \d+$/);
  });

  it("refuses alias bombs", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 8; i++) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      lines.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(", ")}]`);
    }
    lines.push("services: { db: { image: postgres, x: *h } }");
    expect(parseCompose(lines.join("\n")).error).toMatch(/aliases/);
  });
});

describe("parsePrismaSchema env variables", () => {
  it("reads url, directUrl, and shadowDatabaseUrl variables", () => {
    const schema = parsePrismaSchema(
      [
        "datasource db {",
        '  provider          = "postgresql"',
        '  url               = env("DATABASE_URL")',
        '  directUrl         = env( "DIRECT_URL" )',
        '  shadowDatabaseUrl = env("SHADOW_URL")',
        "}",
      ].join("\n"),
    );
    expect(schema.datasources).toEqual([
      {
        name: "db",
        provider: "postgresql",
        line: 1,
        column: 1,
        urlEnv: "DATABASE_URL",
        extraEnv: ["DIRECT_URL", "SHADOW_URL"],
      },
    ]);
  });
});

describe("relinkStores", () => {
  it("retargets only linked stores edges", () => {
    const edge = (to: string) => ({
      id: `stores:m->${to}`,
      kind: "stores" as const,
      from: "m",
      to,
      confidence: "exact" as const,
      sites: [],
    });
    const result = relinkStores(
      {
        nodes: [
          {
            id: "p",
            kind: "datastore",
            label: "postgres",
            parentId: "system:root",
            engine: "postgres",
          },
          { id: "q", kind: "datastore", label: "mysql", parentId: "system:root", engine: "mysql" },
        ],
        edges: [edge("q"), edge("p")],
      },
      new Map([["p", { to: "c", confidence: "heuristic" as const }]]),
    );
    expect(result.nodes.map((n) => n.id)).toEqual(["q"]);
    expect(result.edges.map((e) => `${e.id} ${e.confidence}`)).toEqual([
      "stores:m->c heuristic",
      "stores:m->q exact",
    ]);
  });
});

describe("buildInfra via analyze", () => {
  it("links a datasource to the compose service its URL names", async () => {
    await prismaApp();
    await put("docker-compose.yml", [
      "services:",
      "  db:",
      "    image: postgres:16",
      "    environment:",
      "      POSTGRES_PASSWORD: planted-compose-password",
      "  cache:",
      "    image: redis:7",
      "  mq:",
      "    image: rabbitmq:3-management",
      "  api:",
      "    build: .",
    ]);
    await put(".env", ["DATABASE_URL=postgresql://shop:planted-env-password@db:5432/shop"]);
    const graph = await analyze(dir);
    expect(infraNodes(graph)).toEqual([
      "datastore:infra/cache redis cache (docker-compose.yml:6)",
      "datastore:infra/db postgres db (docker-compose.yml:2)",
      "queue:infra/mq rabbitmq mq (docker-compose.yml:8)",
    ]);
    expect(stores(graph)).toEqual(["model:api/User -> datastore:infra/db (exact)"]);
    expect(infraWarnings(graph)).toEqual([]);
    expect(stringifyGraph(graph)).not.toMatch(/planted/);
  });

  it("links through a published loopback port, merged from an override file", async () => {
    await prismaApp();
    await put("docker/docker-compose.yml", ["services:", "  postgres:", "    image: postgres"]);
    await put("docker/docker-compose.override.yml", [
      "services:",
      "  postgres:",
      "    ports: ['5450:5432']",
    ]);
    await put("prisma/.env.example", ['DATABASE_URL="postgresql://u:p@localhost:5450/db"']);
    const graph = await analyze(dir);
    expect(infraNodes(graph)).toEqual([
      "datastore:infra/docker/postgres postgres postgres (docker/docker-compose.yml:2)",
    ]);
    expect(stores(graph)).toEqual([
      "model:api/User -> datastore:infra/docker/postgres (heuristic)",
    ]);
  });

  it("falls back to the only compose service of the engine when no env file sets the URL", async () => {
    await prismaApp();
    await put("compose.yaml", ["services:", "  pg:", "    image: postgis/postgis"]);
    // An env file in a sibling folder doesn't apply to prisma/schema.prisma.
    await put("other/.env", ["DATABASE_URL=postgres://elsewhere:5432/x"]);
    const graph = await analyze(dir);
    expect(stores(graph)).toEqual(["model:api/User -> datastore:infra/pg (heuristic)"]);
  });

  it("keeps the datasource's own datastore when the URL points elsewhere", async () => {
    await prismaApp();
    await put("docker-compose.yml", ["services:", "  db:", "    image: postgres"]);
    await put(".env", ["DATABASE_URL=postgres://u:p@prod.rds.amazonaws.com:5432/db"]);
    const graph = await analyze(dir);
    expect(stores(graph)).toEqual([
      "model:api/User -> datastore:infra/api/prisma/schema.prisma#db (exact)",
    ]);
    expect(stringifyGraph(graph)).not.toMatch(/rds\.amazonaws/);
  });

  it("warns instead of guessing between equally good services", async () => {
    await prismaApp();
    await put("a/docker-compose.yml", ["services:", "  db:", "    image: postgres"]);
    await put("b/docker-compose.yml", ["services:", "  db:", "    image: postgres"]);
    const graph = await analyze(dir);
    expect(stores(graph)).toEqual([
      "model:api/User -> datastore:infra/api/prisma/schema.prisma#db (exact)",
    ]);
    expect(infraWarnings(graph)).toEqual([
      "INFRA_AMBIGUOUS_DATASTORE prisma/schema.prisma: the datasource could be any of datastore:infra/a/db, datastore:infra/b/db; it keeps its own datastore",
    ]);
  });

  it("adds env-only datastores for URL keys nothing else explains", async () => {
    await prismaApp(['  url = env("DATABASE_URL")', '  directUrl = env("DIRECT_URL")']);
    await put("docker-compose.yml", [
      "services:",
      "  redis:",
      "    image: redis",
      "    ports: ['6379:6379']",
    ]);
    await put(".env.example", [
      "DATABASE_URL=postgres://u:p@prod.example.com/db",
      "DIRECT_URL=postgres://u:p@prod.example.com/db",
      "CACHE_URL=redis://localhost:6379",
      "SESSION_URL=rediss://:planted-redis-pw@sessions.example.com:6380",
      "BROKER_URL=amqps://u:p@mq.example.com",
      "SITE_URL=https://shop.example.com",
      "STRIPE_SECRET_KEY=sk_live_planted",
    ]);
    const graph = await analyze(dir);
    expect(infraNodes(graph)).toEqual([
      "datastore:infra/api/prisma/schema.prisma#db postgres postgres (prisma/schema.prisma:1)",
      "datastore:infra/env#SESSION_URL redis redis (.env.example:4)",
      "datastore:infra/redis redis redis (docker-compose.yml:2)",
      "queue:infra/env#BROKER_URL rabbitmq rabbitmq (.env.example:5)",
    ]);
    const text = stringifyGraph(graph);
    expect(text).not.toMatch(/planted|example\.com/);
  });

  it("warns about unreadable compose files and variable images", async () => {
    await put("package.json", [JSON.stringify({ name: "api" })]);
    await put("docker-compose.yml", ["services:", "  db:", "    image: ${DB_IMAGE:-postgres}"]);
    await put("docker-compose.test.yml", ["services:", "  db: [unclosed"]);
    const graph = await analyze(dir);
    expect(infraNodes(graph)).toEqual([]);
    expect(infraWarnings(graph)).toEqual([
      "COMPOSE_INVALID docker-compose.test.yml: could not parse YAML at line 3; ignored",
      "COMPOSE_DYNAMIC_IMAGE docker-compose.yml: service db sets its image from a variable, so its engine is unknown",
    ]);
  });

  it("skips a compose service with an empty name instead of failing the graph (M2 review)", async () => {
    await put("package.json", [JSON.stringify({ name: "api" })]);
    await put("docker-compose.yml", [
      "services:",
      '  "":',
      "    image: postgres",
      "  db:",
      "    image: redis",
    ]);
    const graph = await analyze(dir);
    expect(infraNodes(graph)).toEqual(["datastore:infra/db redis db (docker-compose.yml:4)"]);
    expect(infraWarnings(graph)).toEqual([
      "COMPOSE_INVALID docker-compose.yml: a service at line 2 has an empty name; ignored",
    ]);
  });

  it("never links a literal Prisma URL to a compose service by engine alone (M2 review)", async () => {
    await prismaApp(['  url = "postgresql://u:p@prod.neon.tech/app"']);
    await put("docker-compose.yml", ["services:", "  testdb:", "    image: postgres"]);
    const graph = await analyze(dir);
    expect(stores(graph)).toEqual([
      "model:api/User -> datastore:infra/api/prisma/schema.prisma#db (exact)",
    ]);
    expect(stringifyGraph(graph)).not.toMatch(/neon\.tech/);
  });
});
