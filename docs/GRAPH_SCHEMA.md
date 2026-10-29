# Graph schema: `architecture.json`

The analyzer's output and the contract between every package. The source of truth is [`packages/schema`](../packages/schema/src/schema.ts) (TypeScript types + Zod). This document explains it. If the two disagree, the code wins, and this doc gets fixed.

**Current version:** `1.0.0` (`SCHEMA_VERSION`). A breaking change bumps the major version and needs an ADR. The viewer and diff refuse graphs with a different major version.

## Document

```ts
{
  schemaVersion: "1.0.0",
  repo: { owner: "acme", name: "shop", sha?: "a1b2c3f…" },
  analyzerVersion: "0.1.0",
  nodes: GraphNode[],
  edges: GraphEdge[],
  warnings: { code, message, file? }[]   // non-fatal: syntax errors, skipped files, missing tsconfig
}
```

There are no timestamps or machine-specific data. Timing and stats live in the database (`analyses.stats`), so the graph stays deterministic.

## Nodes

Every node has `id`, `kind`, `label`, `parentId` (null only for the system root), an optional `layer`, and an optional `source` (`{ file, line, column, endLine? }`, repo-relative, 1-based).

| kind | Extra fields | Parent | Example id |
|---|---|---|---|
| `system` | none | none (root) | `system:root` |
| `service` | `root`, `framework?` | system | `service:api/` |
| `module` | `path` | service | `module:api/src/routes` |
| `file` | `path`, `hash` (SHA-256 of content) | module or service | `file:api/src/routes/orders.ts` |
| `symbol` | `symbolKind` (function, class, method, variable), `exported` | file, or class for methods | `symbol:api/src/routes/orders.ts#createOrder` |
| `route` | `method`, `path` (e.g. `/api/users/:id`, full path after mounts) | file that declares it | `route:api/POST /api/orders` (service = the app that serves it) |
| `page` | `path` (URL path) | file | `page:web//checkout` |
| `model` | `fields[]` (`name`, `type`, `optional`; `type` keeps `[]` for lists) | the `.prisma` file that declares it | `model:api/Order` |
| `datastore` | `engine` (`postgres`, `mysql`, `mongo`, `redis`, …) | system | a compose service, `datastore:infra/<compose dir>/<service>` (`datastore:infra/postgres` at the root); a Prisma datasource no compose service matches, `datastore:infra/api/prisma/schema.prisma#db` (ADR-0028); an env URL nothing else explains, `datastore:infra/env#REDIS_URL` (ADR-0036) |
| `queue` | `engine`, `name?` | system | a BullMQ, Bull, or Bee-Queue queue by name, `queue:infra/redis#receipts` (ADR-0037); a compose broker (RabbitMQ, Kafka, NATS), `queue:infra/mq` |
| `external` | `host` (lowercased, no credentials, no default port) | system | `external:ext/api.stripe.com` |
| `unresolved` | `reason`, `expression` (for HTTP requests, string contents outside the URL path masked as `…`, ADR-0038), `detail?` (why, in words shown to the user) | the service containing the call | `unresolved:web/app/blog/page.tsx:9:15` (line:column of the expression) |

**ID rules** (ADR-0019): `nodeId(kind, service, qualified)` gives `<kind>:<service>/<qualified>`.
- IDs come from qualified names, never from array positions or hashes, so they stay stable across commits.
- Paths always use `/`.
- Infra-level nodes use the pseudo-service `infra`; externals use `ext`.

**Layer** (drives color):
- `frontend`: services with a React/Next frontend, and their pages.
- `backend`: API services and routes.
- `data`: models and datastores.
- `infra`: queues and other compose services.
- `external`: third-party APIs.

## Edges

```ts
{ id, kind, from, to, confidence, label?, reason?, fields?: string[], sites: SourceLocation[] }
```

`fields` appears only on `reads`/`writes` edges to a model: the model fields the call sites name in `select`, `where`, `data`, and similar arguments, sorted (ADR-0028). M6 uses it to flag a removed field that is still read.

- There is one edge per `(kind, from, to)`, with ID `edgeId(kind, from, to)`, i.e. `<kind>:<from>-><to>`. Each call site that produced it is listed in `sites`.
- Edges connect leaf-level nodes (symbols, routes, pages, models, datastores, externals). The viewer aggregates them upward to whatever level is visible.
- Hierarchy is never an edge; it's `parentId`.

| kind | From → to | Meaning |
|---|---|---|
| `imports` | file → file, or → unresolved | import, re-export, or literal `require`/`import()`; a local specifier that doesn't resolve targets an `unresolved` node (`UNKNOWN_SYMBOL`) |
| `calls` | symbol → symbol | call whose callee resolves to a symbol in the repo (including across workspace packages); unresolved callees get no edge (ADR-0025) |
| `http` | symbol, inline-handler route, or (top-level code) file → route, or → unresolved | outbound HTTP call matched to a route (§7 of DESIGN.md); several equally good routes each get an edge with confidence one level weaker (not below `heuristic`) and `reason: "AMBIGUOUS"` (ADR-0033). A call that matches nothing targets an `unresolved` node at the call site (`DYNAMIC_URL`, `WRAPPER_DEPTH`, `NO_MATCHING_ROUTE`), so no call site is dropped (ADR-0034) |
| `handles` | route → symbol | handler or middleware function of a route (Express, or the exported Next.js handler); routes with non-static paths are `unresolved` nodes (`DYNAMIC_ROUTE`) with no edge (ADR-0026, ADR-0027) |
| `renders` | page → symbol | page component: the page file's default export (ADR-0027) |
| `reads`, `writes` | symbol or route → model, or → unresolved | Prisma client usage; the route is the source when the call sits in an inline Express handler. Raw queries target an `unresolved` node (`RAW_QUERY`), as do calls naming an unknown (`UNKNOWN_SYMBOL`) or ambiguous (`AMBIGUOUS`) model (ADR-0028) |
| `stores` | model → datastore | model persisted in a datastore (from the Prisma `datasource`). When the datasource's env URL names a compose service, the edge targets that service's node instead: `exact` by host name, `heuristic` by a published localhost port or as the only compose service of that engine (ADR-0036) |
| `publishes`, `consumes` | symbol, inline-handler route, or file → queue, or → unresolved | queue producer (`add`, `addBulk`, flows, `createJob`) and consumer (the `Worker` or `process` processor's symbol, else the code that creates it) for BullMQ, Bull, and Bee-Queue. A queue name computed at runtime targets an `unresolved` node (`DYNAMIC_NAME`) (ADR-0037) |
| `external_call` | symbol, inline-handler route, or file → external | SDK or literal-host call to a third party; a literal-host `fetch`/axios call is `exact` unless the call itself was reached more weakly (ADR-0034). An allowlisted SDK call targets the node of the SDK's API host, so it shares the node with `fetch` calls to that host; it is `exact`, or `heuristic` when the client came through a heuristic import or the host is inferred from an AWS package name (ADR-0035) |

**Confidence** (drives line style):
- `exact`: fully determined by literals and resolved symbols.
- `pattern`: matched via a parameter or wildcard alignment.
- `heuristic`: depends on an assumption, such as an env-var base URL pointing at this backend.
- `unresolved`: could not be determined. **The target must be an `unresolved` node, and vice versa.**

**Unresolved reasons:** `DYNAMIC_URL`, `NO_MATCHING_ROUTE`, `AMBIGUOUS`, `EXTERNAL_HOST`, `WRAPPER_DEPTH`, `DYNAMIC_ROUTE`, `RAW_QUERY`, `UNKNOWN_SYMBOL`, `DYNAMIC_NAME` (a queue name computed at runtime). Unresolved items are always kept and shown, never dropped.

## Integrity rules (enforced by `parseGraph`)

1. Node IDs are unique, and edge IDs are unique.
2. There is exactly one `system` node, and it has `parentId: null`. Every other node has an existing parent.
3. There are no parent cycles.
4. Every edge's `from` and `to` exist.
5. `confidence: "unresolved"` is used exactly when the target is an `unresolved` node.
6. No unknown fields (strict objects).

## Canonical serialization

`stringifyGraph(graph)` is the only way graphs are written (snapshots, golden files, R2):
- Nodes and edges are sorted by `id`, edge `sites` by file/line/column, and warnings by code/file/message. Model fields keep declaration order.
- Object keys are sorted. Undefined values are omitted.
- Output uses a 2-space indent and a trailing newline.
- String ordering uses a code-unit comparison (`compareStrings`), never `localeCompare`, which differs between machines.

The determinism test (TESTING.md) analyzes each fixture twice and compares the `stringifyGraph` bytes.

## Graph diff: `GraphDiff`

What changed between a base and a head graph of one repo (DESIGN.md §8). `packages/diff` produces it; the viewer's diff mode and the PR bot read it. Defined in [`packages/schema/src/diff.ts`](../packages/schema/src/diff.ts) (ADR-0084).

```ts
{
  schemaVersion: "1.0.0",
  analyzerVersion: "0.1.0",               // both graphs; a diff across analyzer versions is refused
  base: { repo }, head: { repo },          // repo = { owner, name, sha? } as in the graph
  nodes: { added: GraphNode[], removed: string[], modified: NodeChange[], updated: NodeChange[], renamed: NodeRename[] },
  edges: { added: GraphEdge[], removed: string[], modified: EdgeChange[], updated: EdgeChange[], renamed: EdgeRename[] },
  broken: BrokenEdge[],
  warnings: { added: AnalysisWarning[], removed: AnalysisWarning[] },
  summary: { nodes: counts, edges: counts, broken: number }   // counts of every list
}
NodeChange = { node: GraphNode, changes: string[] }            // head record + names of the fields that differ
NodeRename = { from: string, node: GraphNode, changes: string[] }
EdgeChange = { edge: GraphEdge, changes: string[] }
EdgeRename = { from: string, edge: GraphEdge, changes: string[] }
BrokenEdge = { edge, from, to, reason, detail, sites }
```

- **Complete on its own:** added, changed, and renamed items carry the whole head record, removed items their base ID, so `applyDiff(base, diff)` rebuilds head byte for byte.
- **`modified` vs. `updated`:** both mean "same ID, different record". `modified` is a change a reviewer cares about (a fingerprint field: a file's hash, a model's fields, an edge's confidence); `updated` covers everything else (a source line that moved, the sites of an edge) and isn't shown as a change. Fingerprint fields (`NODE_FINGERPRINTS` in `packages/diff/src/fingerprint.ts`, ADR-0085): `kind`, `parentId`, and `layer` for every node, plus service `root`/`framework`, module `path`, file `path`/`hash`, symbol `symbolKind`/`exported`, route `method`/`path`, page `path`, model `fields` (compared as a set by name, so reordering is `updated`), datastore `engine`, queue `engine`/`name`, external `host`, unresolved `reason`/`expression`/`detail`. `label` and `source` are never fingerprints. For edges, every field but `sites`.
- **`renamed`:** a base item that reappears under another ID (`from` is its base ID). Edges whose endpoints were renamed get new IDs (`edgeId` embeds them), so they're listed as renamed edges, not as removed + added.
- **`changes`:** the names of the record's top-level fields that differ, never `id`. At least one for `modified` and `updated`; possibly none for a pure rename.
- **`broken`:** a base edge (`edge`) whose source (`from`) still exists in head and still makes the call, but whose target (`to`, its base ID) no longer answers it. `reason` is `TARGET_REMOVED`, `ROUTE_CHANGED`, `PARAMETERS_ADDED`, or `FIELD_REMOVED`; `detail` says it in words; `sites` are the head call sites.
- **Warnings** are a multiset: head's are base's minus `removed` (one occurrence each) plus `added`.

**Integrity rules** (enforced by `parseGraphDiff`): records are valid graph nodes and edges; each node ID and each edge ID appears in at most one list (a rename's `from` and head ID both count); each base edge is broken at most once; `summary` matches the lists (`summarizeDiff`); no unknown fields.

**Canonical serialization:** `stringifyDiff(diff)` is the only way diffs are written. Entries are sorted by head ID (removed IDs as strings), `changes` by name, broken edges by edge ID then reason, sites and warnings as in graphs; keys sorted, 2-space indent, trailing newline.

## Example

```json
{
  "analyzerVersion": "0.1.0",
  "edges": [
    {
      "confidence": "exact",
      "from": "page:web//checkout",
      "id": "http:page:web//checkout->route:api/POST /api/orders",
      "kind": "http",
      "label": "POST /api/orders",
      "sites": [{ "column": 10, "file": "apps/web/lib/api.ts", "line": 14 }],
      "to": "route:api/POST /api/orders"
    }
  ],
  "nodes": ["…"],
  "repo": { "name": "shop", "owner": "acme", "sha": "a1b2c3f" },
  "schemaVersion": "1.0.0",
  "warnings": []
}
```
