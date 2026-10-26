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
| `route` | `method`, `path` (e.g. `/api/users/:id`) | file that declares it | `route:api/POST /api/orders` |
| `page` | `path` (URL path) | file | `page:web//checkout` |
| `model` | `fields[]` (`name`, `type`, `optional`) | service (or `prisma` module) | `model:api/Order` |
| `datastore` | `engine` (`postgres`, `mysql`, `mongo`, `redis`, …) | system | `datastore:infra/postgres` |
| `queue` | `engine`, `name?` | system | `queue:infra/redis#receipts` |
| `external` | `host` | system | `external:ext/api.stripe.com` |
| `unresolved` | `reason`, `expression` | the service containing the call | `unresolved:web/app/blog/page.tsx:9:15` (line:column of the expression) |

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
{ id, kind, from, to, confidence, label?, reason?, sites: SourceLocation[] }
```

- There is one edge per `(kind, from, to)`, with ID `edgeId(kind, from, to)`, i.e. `<kind>:<from>-><to>`. Each call site that produced it is listed in `sites`.
- Edges connect leaf-level nodes (symbols, routes, pages, models, datastores, externals). The viewer aggregates them upward to whatever level is visible.
- Hierarchy is never an edge; it's `parentId`.

| kind | From → to | Meaning |
|---|---|---|
| `imports` | file → file, or → unresolved | import, re-export, or literal `require`/`import()`; a local specifier that doesn't resolve targets an `unresolved` node (`UNKNOWN_SYMBOL`) |
| `calls` | symbol → symbol | call whose callee resolves to a symbol in the repo (including across workspace packages); unresolved callees get no edge (ADR-0025) |
| `http` | symbol or page → route, or → unresolved | outbound HTTP call matched to a route (§7 of DESIGN.md) |
| `handles` | route → symbol | handler function of a route |
| `renders` | page → symbol | page component |
| `reads`, `writes` | symbol or route → model | Prisma client usage |
| `stores` | model → datastore | model persisted in a datastore |
| `publishes`, `consumes` | symbol → queue | queue producer and consumer (v1: BullMQ / known clients) |
| `external_call` | symbol → external | SDK or literal-host call to a third party |

**Confidence** (drives line style):
- `exact`: fully determined by literals and resolved symbols.
- `pattern`: matched via a parameter or wildcard alignment.
- `heuristic`: depends on an assumption, such as an env-var base URL pointing at this backend.
- `unresolved`: could not be determined. **The target must be an `unresolved` node, and vice versa.**

**Unresolved reasons:** `DYNAMIC_URL`, `NO_MATCHING_ROUTE`, `AMBIGUOUS`, `EXTERNAL_HOST`, `WRAPPER_DEPTH`, `DYNAMIC_ROUTE`, `RAW_QUERY`, `UNKNOWN_SYMBOL`. Unresolved items are always kept and shown, never dropped.

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
