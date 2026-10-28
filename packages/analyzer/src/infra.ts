/**
 * Infra detector (M2.7): `datastore` and `queue` nodes from docker-compose services and
 * `.env*` URLs, and the link from a Prisma datasource to the compose service it runs on, so
 * models' `stores` edges reach that one node instead of a second copy (ADR-0036).
 *
 * Patterns handled:
 * - Compose files: `docker-compose.yml`, `compose.yaml`, and variants such as
 *   `docker-compose.dev.yml` or `docker-compose-test.yaml`, anywhere in the inventory. Each
 *   entry under `services:` whose `image` names a known engine (see {@link imageEngine}:
 *   `postgres`, `postgis/postgis`, `bitnami/postgresql`, `mysql`, `mariadb`, `mongo`, `redis`,
 *   `valkey/valkey`, `rabbitmq:3-management`, `confluentinc/cp-kafka`, …; registry hosts, tags,
 *   and digests are ignored) becomes `datastore:infra/<dir>/<service>` (`datastore:infra/<service>`
 *   at the repo root), or `queue:…` for brokers (RabbitMQ, Kafka, Redpanda, NATS). Files in
 *   one folder are one Compose project, so a service defined in both `docker-compose.yml` and
 *   an override file is one node; its host names (`container_name`, `hostname`, network
 *   aliases) and published host ports are merged. YAML anchors and `<<` merge keys work.
 * - Env files: `.env` and `.env.<anything>` (`.env.local`, `.env.example`, …). Lines are
 *   `KEY=value`, optionally `export KEY=value`, with `#` comments and quoted values, including
 *   quoted values that span lines. Only the key and, when the value is a URL, its scheme,
 *   host, and port are kept; the rest of the value (credentials, paths, query) is discarded
 *   at parse time and nothing read from a value is ever written into the graph.
 * - Prisma links: a datasource with `url = env("KEY")` is the compose service whose host
 *   name is the URL's host and whose engine matches (`exact`), else the one publishing the
 *   URL's port (or the engine's default port) on a loopback host (`heuristic`). The env files
 *   searched are those in the schema file's folder or any folder above it. When the variable
 *   appears in no env file (or none of its values is a URL), a lone compose service with the
 *   datasource's engine is linked (`heuristic`). Several equally good services are a guess,
 *   so the datasource keeps its own
 *   datastore and an `INFRA_AMBIGUOUS_DATASTORE` warning says why. A value that points
 *   elsewhere (a cloud host, Prisma Accelerate) keeps the datasource's own datastore.
 * - Env-only datastores: a key whose URL scheme names an engine (`postgres://`, `mongodb+srv://`,
 *   `rediss://`, `amqp://`, …), that no Prisma datasource reads and that no compose service
 *   serves, becomes `datastore:infra/env#<KEY>` (or `queue:…`), labeled with the engine.
 *
 * Patterns not handled:
 * - Compose `extends`, `include`, `profiles`, `env_file`, `environment`, and `build`-only
 *   services (those are the repo's own apps); images set from a variable
 *   (`image: ${DB_IMAGE}`, warned as `COMPOSE_DYNAMIC_IMAGE`); images not in the table.
 * - Variable interpolation inside env values (`postgres://${HOST}/db` has no readable host),
 *   `KEY: value` lines, and env files with other names (`config.env`, `.envrc`).
 * - `*_API_KEY` keys: a key alone isn't a connection, and SDK calls already draw
 *   `external_call` edges (M2.6).
 * - Literal Prisma URLs (`url = "postgres://…"`): the datasource keeps its own datastore and
 *   is never linked by engine alone. Also `prisma.config.ts`, and other ORMs'
 *   connection settings; Kubernetes, Terraform, and other infra formats (v1.1).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, isMap, isScalar, parseDocument } from "yaml";
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
} from "@gitinside/schema";
import { SOURCE_EXTENSIONS } from "./inventory.js";
import type { PrismaDatastore } from "./prisma.js";
import { weaker } from "./values.js";

/** Compose file names, matched against the base name. */
const COMPOSE_FILE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/;

/** Env file names, matched against the base name. */
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;

/** Images whose full path (registry dropped) names the engine. Checked before {@link IMAGE_NAMES}. */
const IMAGE_PATHS: ReadonlyMap<string, string> = new Map([["mssql/server", "sqlserver"]]);

/** Images whose last path segment names the engine. */
const IMAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ["azure-sql-edge", "sqlserver"],
  ["clickhouse-server", "clickhouse"],
  ["cockroach", "cockroachdb"],
  ["cp-kafka", "kafka"],
  ["cp-server", "kafka"],
  ["dragonfly", "redis"],
  ["elasticsearch", "elasticsearch"],
  ["kafka", "kafka"],
  ["keydb", "redis"],
  ["mariadb", "mysql"],
  ["meilisearch", "meilisearch"],
  ["memcached", "memcached"],
  ["minio", "minio"],
  ["mongo", "mongo"],
  ["mongodb", "mongo"],
  ["mongodb-community-server", "mongo"],
  ["mysql", "mysql"],
  ["nats", "nats"],
  ["opensearch", "opensearch"],
  ["pgvector", "postgres"],
  ["postgis", "postgres"],
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["rabbitmq", "rabbitmq"],
  ["redis", "redis"],
  ["redis-stack", "redis"],
  ["redis-stack-server", "redis"],
  ["redpanda", "redpanda"],
  ["timescaledb", "postgres"],
  ["timescaledb-ha", "postgres"],
  ["typesense", "typesense"],
  ["valkey", "redis"],
]);

/** URL schemes that name an engine. */
const SCHEME_ENGINES: ReadonlyMap<string, string> = new Map([
  ["amqp", "rabbitmq"],
  ["amqps", "rabbitmq"],
  ["mariadb", "mysql"],
  ["mongodb", "mongo"],
  ["mongodb+srv", "mongo"],
  ["mysql", "mysql"],
  ["nats", "nats"],
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["redis", "redis"],
  ["rediss", "redis"],
  ["sqlserver", "sqlserver"],
]);

/** Engines that are message brokers, so they become `queue` nodes. */
const QUEUE_ENGINES: ReadonlySet<string> = new Set(["kafka", "nats", "rabbitmq", "redpanda"]);

/** Each engine's default port, used when an env URL names none. */
const DEFAULT_PORTS: ReadonlyMap<string, number> = new Map([
  ["cockroachdb", 26257],
  ["mongo", 27017],
  ["mysql", 3306],
  ["nats", 4222],
  ["postgres", 5432],
  ["rabbitmq", 5672],
  ["redis", 6379],
  ["sqlserver", 1433],
]);

/** Hosts that mean "this machine", where a compose service's published port is reachable. */
const LOOPBACK: ReadonlySet<string> = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
  "localhost",
]);

/** Most aliases a compose file may expand before it's rejected (billion-laughs guard). */
const MAX_ALIASES = 100;

/** The parts of a URL value the detector keeps. Everything else is discarded. */
export interface UrlAuthority {
  /** Lowercased scheme, e.g. `postgresql`. */
  scheme: string;
  /** Lowercased host without credentials, when readable. */
  host?: string;
  port?: number;
}

/** One `KEY=value` line of an env file. Lines and columns are 1-based. */
export interface EnvEntry {
  key: string;
  line: number;
  column: number;
  /** Present when the value is a URL. */
  url?: UrlAuthority;
}

/** One entry under a compose file's `services:`. */
export interface ComposeService {
  name: string;
  line: number;
  column: number;
  /** The `image` string, when set. */
  image?: string;
  /** Names other containers can reach it by: the service name, `container_name`, `hostname`, aliases. */
  hostnames: string[];
  /** Host ports it publishes, from short (`"5450:5432"`) or long (`published:`) syntax. */
  ports: number[];
}

/**
 * The scheme, host, and port of a URL value, or undefined when it isn't `scheme://…`.
 * Credentials are dropped. A host with a variable, a list (`h1,h2`), or spaces is left out.
 */
export function urlAuthority(value: string): UrlAuthority | undefined {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(value.trim());
  if (!match) return undefined;
  const scheme = (match[1] ?? "").toLowerCase();
  const raw = match[2] ?? "";
  const authority = raw.slice(raw.lastIndexOf("@") + 1);
  const parts =
    /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority) ??
    /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  const host = parts?.[1];
  if (host === undefined || /[$,{}\s]/.test(host)) return { scheme };
  const port = parts?.[2];
  return {
    scheme,
    host: host.toLowerCase(),
    ...(port !== undefined ? { port: Number(port) } : {}),
  };
}

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;

const QUOTES = ['"', "'", "`"] as const;

/**
 * Parse an env file into its keys and URL authorities. Values are read only to find a URL
 * and are not returned. Never throws: unreadable lines are skipped. A quoted value that
 * continues onto later lines is skipped whole; a quote that never closes is read as a
 * one-line value, so one bad line can't hide the rest of the file.
 */
export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = text.split(/\r?\n/);
  // For each quote, the next line at or after `i` containing it (one backward pass each,
  // so finding where a value closes never rescans the file).
  const closing = new Map<string, Int32Array>();
  for (const quote of QUOTES) {
    const next = new Int32Array(lines.length + 1).fill(-1);
    for (let i = lines.length - 1; i >= 0; i--) {
      next[i] = lines[i]?.includes(quote) ? i : (next[i + 1] ?? -1);
    }
    closing.set(quote, next);
  }
  for (let index = 0; index < lines.length; index++) {
    const match = ENV_LINE.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[2] ?? "";
    const line = index + 1;
    let value = match[3] ?? "";
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = value.indexOf(quote, 1);
      const closes = end < 0 ? (closing.get(quote)?.[index + 1] ?? -1) : -1;
      if (closes >= 0) index = closes;
      value = value.slice(1, end < 0 ? undefined : end);
    } else {
      const comment = value.indexOf("#");
      if (comment >= 0) value = value.slice(0, comment);
    }
    const url = urlAuthority(value);
    entries.push({
      key,
      line,
      column: (match[1] ?? "").length + 1,
      ...(url ? { url } : {}),
    });
  }
  return entries;
}

/**
 * The engine a container image runs, or undefined when it isn't in the table. Registry hosts
 * (`docker.io/`, `ghcr.io/`), `library/`, tags, and digests are ignored: `postgres:16-alpine`,
 * `docker.io/bitnami/postgresql@sha256:…`, and `postgis/postgis` are all `postgres`.
 */
export function imageEngine(image: string): string | undefined {
  let ref = image.trim().toLowerCase();
  const at = ref.indexOf("@");
  if (at >= 0) ref = ref.slice(0, at);
  const colon = ref.lastIndexOf(":");
  if (colon > ref.lastIndexOf("/")) ref = ref.slice(0, colon);
  const parts = ref.split("/");
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0] ?? "")) parts.shift();
  if (parts.length > 1 && parts[0] === "library") parts.shift();
  return IMAGE_PATHS.get(parts.join("/")) ?? IMAGE_NAMES.get(parts[parts.length - 1] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host port of one `ports:` entry, or undefined when it publishes none we can read. */
function publishedPort(entry: unknown): number | undefined {
  if (isRecord(entry)) {
    const published = entry.published;
    const text = typeof published === "number" ? String(published) : published;
    return typeof text === "string" && /^\d{1,5}$/.test(text) ? Number(text) : undefined;
  }
  // Short syntax: `[ip:]host:container[/protocol]`. A bare container port publishes a
  // random host port, and ranges or variables can't be read.
  if (typeof entry !== "string" || entry.length > 64) return undefined;
  const match = /^(?:.*:)?(\d{1,5}):\d{1,5}$/.exec(entry.replace(/\/\w+$/, ""));
  return match ? Number(match[1]) : undefined;
}

/**
 * Parse a compose file's services. Returns an error message (with a line number, never the
 * file's text) instead of throwing when the YAML is invalid or expands too many aliases.
 */
export function parseCompose(text: string): { services: ComposeService[]; error?: string } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, merge: true, prettyErrors: false });
  const failure = doc.errors[0];
  if (failure) {
    // Our own message: yaml's can quote the file, and compose files hold passwords.
    const { line } = lineCounter.linePos(failure.pos[0]);
    return { services: [], error: `could not parse YAML at line ${line}` };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch {
    return { services: [], error: `could not expand YAML aliases (over ${MAX_ALIASES})` };
  }
  const services = isRecord(data) ? data.services : undefined;
  if (!isRecord(services)) return { services: [] };

  const positions = new Map<string, { line: number; col: number }>();
  const node = doc.get("services", true);
  if (isMap(node)) {
    for (const item of node.items) {
      const key = item.key;
      if (isScalar(key) && typeof key.value === "string" && key.range) {
        positions.set(key.value, lineCounter.linePos(key.range[0]));
      }
    }
  }

  const result: ComposeService[] = [];
  for (const name of Object.keys(services).sort(compareStrings)) {
    const service = services[name];
    if (!isRecord(service)) continue;
    const hostnames = new Set([name]);
    for (const key of ["container_name", "hostname"]) {
      const value = service[key];
      if (typeof value === "string") hostnames.add(value);
    }
    if (isRecord(service.networks)) {
      for (const network of Object.values(service.networks)) {
        const aliases = isRecord(network) ? network.aliases : undefined;
        if (!Array.isArray(aliases)) continue;
        for (const alias of aliases) if (typeof alias === "string") hostnames.add(alias);
      }
    }
    const ports = new Set<number>();
    if (Array.isArray(service.ports)) {
      for (const entry of service.ports) {
        const port = publishedPort(entry);
        if (port !== undefined) ports.add(port);
      }
    }
    const position = positions.get(name) ?? { line: 1, col: 1 };
    result.push({
      name,
      line: position.line,
      column: position.col,
      ...(typeof service.image === "string" ? { image: service.image } : {}),
      hostnames: [...hostnames].map((h) => h.toLowerCase()).sort(compareStrings),
      ports: [...ports].sort((a, b) => a - b),
    });
  }
  return { services: result };
}

/** A compose datastore or queue: its node and how other containers reach it. */
interface ComposeStore {
  id: string;
  engine: string;
  hostnames: Set<string>;
  ports: Set<number>;
}

/** An env entry with the file it came from. */
interface EnvValue {
  file: string;
  entry: EnvEntry;
}

/** A Prisma datastore that is really a compose service, and how sure the link is. */
export interface StoreLink {
  to: string;
  confidence: Confidence;
}

/** What {@link buildInfra} found. */
export interface InfraResult {
  /** Compose and env-only `datastore`/`queue` nodes, sorted. */
  nodes: GraphNode[];
  warnings: AnalysisWarning[];
  /** Prisma datastore ID ⇒ the compose node it is. Apply with {@link relinkStores}. */
  links: Map<string, StoreLink>;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};
const isSource = (path: string): boolean => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

/** True when `dir` is `of` or a folder above it. `""` is the repo root. */
function isAncestor(dir: string, of: string): boolean {
  return dir === "" || of === dir || of.startsWith(`${dir}/`);
}

/** The compose stores one URL points at: by host name (`exact`) or loopback + port (`heuristic`). */
function storesFor(
  url: UrlAuthority,
  engine: string,
  stores: readonly ComposeStore[],
): { exact: ComposeStore[]; heuristic: ComposeStore[] } {
  const host = url.host;
  const same = stores.filter((s) => s.engine === engine);
  if (host === undefined) return { exact: [], heuristic: [] };
  const exact = same.filter((s) => s.hostnames.has(host));
  const port = url.port ?? DEFAULT_PORTS.get(engine);
  const heuristic =
    LOOPBACK.has(host) && port !== undefined ? same.filter((s) => s.ports.has(port)) : [];
  return { exact, heuristic };
}

/**
 * Detect compose and env infrastructure in `files` (repo-relative, sorted; read from `root`)
 * and decide which Prisma datastores are compose services (see the file comment).
 */
export async function buildInfra(
  root: string,
  files: readonly string[],
  prismaStores: readonly PrismaDatastore[],
): Promise<InfraResult> {
  const nodes = new Map<string, GraphNode>();
  const warnings: AnalysisWarning[] = [];
  const stores = new Map<string, ComposeStore>();

  // Compose services. Files are sorted, so the first file defining an engine wins the node.
  const pending = new Map<string, { hostnames: string[]; ports: number[] }[]>();
  for (const file of files.filter((f) => COMPOSE_FILE.test(baseName(f)))) {
    const { services, error } = parseCompose(await readFile(join(root, file), "utf8"));
    if (error !== undefined) {
      warnings.push({ code: "COMPOSE_INVALID", file, message: `${error}; ignored` });
      continue;
    }
    const dir = dirName(file);
    for (const service of services) {
      if (service.name.trim() === "") {
        warnings.push({
          code: "COMPOSE_INVALID",
          file,
          message: `a service at line ${service.line} has an empty name; ignored`,
        });
        continue;
      }
      const qualified = dir === "" ? service.name : `${dir}/${service.name}`;
      const extra = pending.get(qualified) ?? [];
      extra.push(service);
      pending.set(qualified, extra);
      if (service.image === undefined) continue;
      if (service.image.includes("$")) {
        warnings.push({
          code: "COMPOSE_DYNAMIC_IMAGE",
          file,
          message: `service ${service.name} sets its image from a variable, so its engine is unknown`,
        });
        continue;
      }
      const engine = imageEngine(service.image);
      if (engine === undefined || stores.has(qualified)) continue;
      const kind = QUEUE_ENGINES.has(engine) ? "queue" : "datastore";
      const id = nodeId(kind, "infra", qualified);
      const source: SourceLocation = { file, line: service.line, column: service.column };
      nodes.set(id, {
        id,
        kind,
        label: service.name,
        parentId: SYSTEM_ID,
        layer: kind === "queue" ? "infra" : "data",
        engine,
        source,
      });
      stores.set(qualified, { id, engine, hostnames: new Set(), ports: new Set() });
    }
  }
  // Override files in the same folder add host names and ports to the same service.
  for (const [qualified, entries] of pending) {
    const store = stores.get(qualified);
    if (!store) continue;
    for (const entry of entries) {
      for (const host of entry.hostnames) store.hostnames.add(host);
      for (const port of entry.ports) store.ports.add(port);
    }
  }
  const composeStores = [...stores.values()].sort((a, b) => compareStrings(a.id, b.id));

  // Env files.
  const envByKey = new Map<string, EnvValue[]>();
  for (const file of files.filter((f) => ENV_FILE.test(baseName(f)) && !isSource(f))) {
    for (const entry of parseEnv(await readFile(join(root, file), "utf8"))) {
      const values = envByKey.get(entry.key) ?? [];
      values.push({ file, entry });
      envByKey.set(entry.key, values);
    }
  }

  // Prisma datasources ⇒ compose services.
  const links = new Map<string, StoreLink>();
  for (const store of prismaStores) {
    const schemaDir = dirName(store.file);
    const urls = (store.urlEnv === undefined ? [] : (envByKey.get(store.urlEnv) ?? []))
      .filter((v) => isAncestor(dirName(v.file), schemaDir))
      .flatMap((v) => (v.entry.url ? [v.entry.url] : []));
    const exact = new Set<ComposeStore>();
    const heuristic = new Set<ComposeStore>();
    for (const url of urls) {
      const found = storesFor(url, store.engine, composeStores);
      for (const s of found.exact) exact.add(s);
      for (const s of found.heuristic) heuristic.add(s);
    }
    const sameEngine = composeStores.filter((s) => s.engine === store.engine);
    const [candidates, confidence]: [ComposeStore[], Confidence] =
      exact.size > 0
        ? [[...exact], "exact"]
        : heuristic.size > 0
          ? [[...heuristic], "heuristic"]
          : urls.length === 0 && !store.urlOther
            ? [sameEngine, "heuristic"]
            : [[], "heuristic"];
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      links.set(store.id, { to: only.id, confidence });
    } else if (candidates.length > 1) {
      const names = candidates.map((c) => c.id).sort(compareStrings);
      warnings.push({
        code: "INFRA_AMBIGUOUS_DATASTORE",
        file: store.file,
        message: `the datasource could be any of ${names.join(", ")}; it keeps its own datastore`,
      });
    }
  }

  // Env-only datastores: URL keys no Prisma datasource reads and no compose service serves.
  const consumed = new Set(prismaStores.flatMap((s) => s.envKeys));
  for (const key of [...envByKey.keys()].sort(compareStrings)) {
    if (consumed.has(key)) continue;
    const values = (envByKey.get(key) ?? []).filter(
      (v) => v.entry.url && SCHEME_ENGINES.has(v.entry.url.scheme),
    );
    const first = values[0];
    const engine = first?.entry.url && SCHEME_ENGINES.get(first.entry.url.scheme);
    if (!first || engine === undefined) continue;
    const served = values.some((v) => {
      const url = v.entry.url;
      const found = url && storesFor(url, engine, composeStores);
      return found !== undefined && found.exact.length + found.heuristic.length > 0;
    });
    if (served) continue;
    const kind = QUEUE_ENGINES.has(engine) ? "queue" : "datastore";
    const id = nodeId(kind, "infra", `env#${key}`);
    nodes.set(id, {
      id,
      kind,
      label: engine,
      parentId: SYSTEM_ID,
      layer: kind === "queue" ? "infra" : "data",
      engine,
      source: { file: first.file, line: first.entry.line, column: first.entry.column },
    });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id)),
    warnings: warnings.sort(
      (a, b) =>
        compareStrings(a.file ?? "", b.file ?? "") ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    ),
    links,
  };
}

/**
 * Apply {@link InfraResult.links} to the Prisma detector's output: each linked datastore node
 * is dropped, and its `stores` edges point at the compose node instead, at the weaker of the
 * edge's and the link's confidence. Everything else is returned unchanged, sorted.
 */
export function relinkStores(
  part: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
  links: ReadonlyMap<string, StoreLink>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edges = part.edges.map((edge): GraphEdge => {
    const link = edge.kind === "stores" ? links.get(edge.to) : undefined;
    if (!link) return edge;
    return {
      ...edge,
      id: edgeId("stores", edge.from, link.to),
      to: link.to,
      confidence: weaker(edge.confidence, link.confidence),
    };
  });
  return {
    nodes: part.nodes.filter((n) => !links.has(n.id)),
    edges: edges.sort((a, b) => compareStrings(a.id, b.id)),
  };
}
