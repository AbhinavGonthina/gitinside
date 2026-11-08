# GitInside technical design

**Git inside your repo.** This document is the technical design for v1. It follows `../gitinside-planning/SPEC.md` (approved 2026-10-25). Decisions are recorded in [DECISIONS.md](DECISIONS.md) (ADR-NNNN). The graph format is in [GRAPH_SCHEMA.md](GRAPH_SCHEMA.md), the UI in [UX.md](UX.md) and [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), and threats in [SECURITY.md](SECURITY.md).

---

## 1. Problem

Developers joining or reviewing a codebase can't see how it actually fits together: which pages call which API routes, which routes touch which tables, which external services are involved. Diagrams drawn by hand go stale. AI-generated diagrams look plausible but aren't verified, and change between runs. PRs that remove a route or field still used elsewhere slip through review because nothing connects the frontend call to the backend change.

## 2. Goals and non-goals

**Goals (v1)**
1. **Accurate, deterministic diagrams:** derived by static analysis of TS/JS repos. Same commit ⇒ identical graph. Every node and edge links to source.
2. **Readable at any size:** a hierarchical drill-down (System → Services → Modules → Files → Symbols), never a hairball.
3. **Cross-service edges:** frontend `fetch`/axios → backend route → model → datastore / external API, each with an explicit confidence level.
4. **PR diffs that flag broken connections,** posted by a GitHub App.
5. **A premium interactive explorer:** trace mode, Ctrl+K, filters, deep links, export.
6. **Published, reproducible numbers:** precision/recall, backtest results, incremental speedup, render performance.
7. **$0 to run.**

**Non-goals (v1)**
- Languages other than TS/JS; TypeORM, Kubernetes, Terraform; tRPC, GraphQL.
- Any LLM use.
- Runtime tracing, or executing analyzed code in any form.
- Editing or committing to users' repos.
- GitLab and Bitbucket.

## 3. Landscape and differentiation

| Tool | What it does | Gap GitInside fills |
|---|---|---|
| GitDiagram | An LLM reads the file tree + README and outputs a Mermaid diagram | Not verified, no function level, no cross-service edges, not deterministic |
| Eraser (Git Diagrammer, Eraserbot) | An AI reads the files a prompt points to and draws a diagram; the bot comments updated diagrams on PRs | AI-generated structure, no measured accuracy, no drill-down to functions, no trace, no broken-edge detection |
| CodeSee (GitKraken) | Codebase maps and review maps | Not focused on cross-service request paths; discontinued as a standalone product |
| Sourcegraph | Code search and precise code intelligence | Not an architecture diagram; no PR architecture diff |
| Swimm | Docs coupled to code | Documentation, not a generated system view |
| Structurizr | C4 diagrams as code | Hand-authored model, goes stale |

**Our claim:** provably accurate (static analysis, published precision/recall, unresolved shown not guessed), deep (drill to functions, trace a request hop by hop), and useful on PRs (detects broken connections, not just a new picture).

## 4. System architecture

```mermaid
flowchart LR
  subgraph Vercel["Vercel Hobby"]
    W["apps/web (Next.js)<br/>pages + route handlers<br/>webhooks"]
  end
  subgraph Google["Google Cloud"]
    R[("Cloud Tasks<br/>max 2 at once, 3 attempts")]
    K["apps/worker on Cloud Run<br/>POST /run, one job per request"]
    C["analysis child process<br/>(limits, no network)"]
  end
  PG[("Neon Postgres<br/>Drizzle<br/>job rows + progress")]
  S3[("Oracle Object Storage<br/>snapshots")]
  GH["GitHub API + App webhooks"]
  U["Browser"]

  U --> W
  W -->|"create task (HMAC-signed job)"| R
  R -->|"push, OIDC"| K --> C
  K -->|"tarball"| GH
  K --> S3
  K --> PG
  W --> PG
  W -->|"signed URL / CDN"| S3
  GH -->|"webhooks"| W
  W -->|"comment + Check Run"| GH
```

**Components**
- **`apps/web`** (Next.js, App Router, on Vercel):
  - Landing page, the `/<owner>/<repo>[/<sha>]` diagram pages, the progress page, and the signed-in dashboard.
  - Route handlers: `/api/analyze`, `/api/jobs/:id`, `/api/badge/:owner/:repo.svg`, `/api/diagram/:owner/:repo.svg`, sign-in (`/api/auth/github`, its callback `/api/auth/github/callback`, and `POST /api/auth/signout`; `lib/authRoute.ts`, ADR-0221), GitHub App webhooks.
  - Never parses repos.
- **The queue** (ADR-0114): Google Cloud Tasks. The web app writes the job's `queued` row in Neon, then creates a task whose body is the job, HMAC-signed (`apps/web/lib/enqueue.ts`, `cloudTasks.ts`, ADR-0141). Cloud Tasks pushes it to the worker with an OIDC token, at most 2 at once, up to 3 attempts. Job state and live progress are the Neon row, so nothing reads the worker to watch a job (ADR-0139). There is no Redis and no enqueue server (BullMQ was removed in M5.17c3). In local development, `LOCAL_TASKS=push` with no `GCP_*` variable swaps in `localTasks.ts`, which pushes the same signed request straight to a loopback worker, with the same retries, one at a time (ADR-0149).
- **`apps/worker`** (a Cloud Run service; `run.ts`, `attempt.ts`, `job.ts`, ADR-0143, ADR-0144):
  - `POST /run` checks the signature and runs one job inside the request, under one 280 s deadline. The answer decides the retry: 200 for success, a permanent failure, or the last attempt; 503 for a retriable failure with attempts left. A push for a job already `done` answers 200 without work (ADR-0145).
  - For each job, streams the tarball from GitHub into a fresh job folder, then forks a child process running `packages/analyzer`, with resource limits. The folder is deleted afterwards, and leftovers are swept at startup.
  - The child is the sandbox for untrusted input (SECURITY.md T1, T4, ADR-0152): Node's permission model (read only the app and the job's `src`, write only the graph file, no processes, threads, addons, `process.binding`, inspector, or WASI), an empty environment, and `netguard.ts` failing every network call. Cloud Run has no free egress allowlist, so the worker process itself has the platform's ordinary outbound network and calls only GitHub, the bucket, and Neon.
  - Retries only failures that can pass (network, rate limit, shutdown); deterministic ones (`LIMIT_*`, `TAR_*`, `REPO_NOT_FOUND`) fail on the first attempt.
  - Uploads the gzipped snapshot to Oracle Object Storage through its S3-compatible API (`storage.ts`, signed with our own SigV4, keyed per repo, SHA, and analyzer version; ADR-0062, ADR-0095), writes metadata to Postgres, and writes each progress update to the job's row.
  - One process (`bin.ts` ⇒ `main.ts`, ADR-0065, ADR-0144): config from env checked up front, the startup sweep (job folders, then rows left `running` past any request's life) before listening, and on SIGTERM an ordered shutdown (cancel the job, answer, stop maintenance, close the database).
  - Deployed from reviewed config in `infra/gcp/` (ADR-0151): the Cloud Run service (1 vCPU / 4 GiB, concurrency 1, ≤ 2 instances, 300 s, internal ingress, a startup probe on `/health`), the Cloud Tasks queue (2 at once, 3 attempts, 30 s and 60 s backoff), and IAM (runtime, invoker, and enqueue accounts, each bound to one resource). `apps/web/lib/gcpConfig.test.ts` keeps it in step with the code.
- **`packages/schema`:** TS types + Zod for `architecture.json`. Imported everywhere.
- **`packages/analyzer`:** library + the `gitinside` CLI: `gitinside analyze <path>`, and `gitinside diff <base> <head>` (each side a graph file, a folder, or a git commit checked out into a temporary worktree; ADR-0089); both take `--cache <dir>` (§9).
- **`packages/diff`:** library: `diffGraphs`, `applyDiff`, and `renderMermaidSummary` (the Mermaid summary of a diff). No Node or TypeScript dependency, so browsers can use it.
- **`packages/viewer`:** React components for the explorer (React Flow + ELK). Used by `apps/web` and Storybook.

## 5. Analyzer pipeline

`packages/analyzer` is pure: input is a directory on disk; output is an `ArchitectureGraph` (see GRAPH_SCHEMA). No network, no execution, deterministic.

```
fetch → inventory → parse → resolve → detect → build graph → link cross-service → group → layout hints → serialize
```

1. **Fetch** (worker only, not the analyzer library):
   - Download `GET /repos/{owner}/{repo}/tarball/{sha}` into a temp dir.
   - Stream-extract with path checks (`apps/worker/src/extract.ts`, ADR-0058): absolute paths and `..` fail the job; symlinks, hard links, and special files are skipped and listed.
   - Enforce limits: total size ≤ 400 MiB extracted and ≤ 60,000 entries (with the 2,560 MB analysis heap, sized to fit one 4 GiB Cloud Run instance whose `/tmp` is memory, ADR-0146). Files over 2 MB are written, and the analyzer's inventory skips them with a `SKIPPED_LARGE` warning, as on a checkout.
2. **Inventory:**
   - Walk files (sorted, for determinism). Skip `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `coverage/`, vendored dirs, and generated files (header markers like `@generated`, or `*.min.js`).
   - Count source files (`.ts .tsx .js .jsx .mjs .cjs .prisma`). Over 20,000 ⇒ fail with `LIMIT_FILES`; over 50 MB together (sizes from the walk) ⇒ fail with `LIMIT_SOURCE_SIZE`, before any parsing (ADR-0137: a repo that size runs out of the worker's heap minutes into parsing).
   - Detect workspaces: root `package.json` `workspaces`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`. Each workspace package with a `package.json` becomes a **service candidate**. With no workspace config at all, each top-level folder with its own `package.json` (`frontend/` + `backend/`) is a service, and the root is one too when it has source files outside them (ADR-0163). A single-package repo is one service. An Nx standalone app's root (`nx.json` plus a root `project.json`) is named by that `project.json` (ADR-0021 amendment, M6.11j).
3. **Parse:** per service, build a `ts.Program` from its `tsconfig.json`, or synthesized options if absent: `allowJs`, `jsx: preserve`, `skipLibCheck`, `noEmit`, `types: []`, and `paths`/`baseUrl` honored. A nested `tsconfig.json`/`jsconfig.json` in a folder without its own `package.json` resolves the imports of the files under it (ADR-0212).
   - There is no `node_modules` on disk, so external imports resolve to an `external package` placeholder.
   - Each file gets a content hash (SHA-256), which keys the incremental cache (§9).
4. **Resolve:**
   - Use the `TypeChecker` for local symbols: functions, classes, exported consts, methods.
   - Resolve imports across files and across workspace packages: map `@acme/shared` to the workspace package path.
   - Record `imports` and `calls` edges between symbols when the callee resolves to a local declaration.
5. **Detect** (framework detectors, a plugin interface in §6):
   - Routes (Express, Next.js app/pages API).
   - Models (Prisma).
   - Outbound HTTP calls (fetch/axios).
   - Infra (docker-compose, `.env`).
   - External SDKs (an allowlist of known clients, e.g. `stripe`, `@aws-sdk/*`, `resend`, `openai`).
6. **Build graph:** create nodes (system, services, modules = top-level folders under a service's source root, files, symbols, routes, models, datastores, queues, externals) with stable IDs (ADR-0019), a parent chain, and source locations.
7. **Link cross-service:** match outbound HTTP calls to routes (§7). Link routes to the symbols that handle them. Link symbols to models through Prisma client usage (`prisma.order.create` ⇒ `reads`/`writes` model `Order`). Link models to the datastore from `datasource db { provider }` + compose/env.
8. **Group:** derive module labels heuristically (folder name, plus a common suffix like `routes/`, `services/`). No LLM (ADR-0003).
9. **Layout hints:** for each container, an ordering hint (topological by edge direction, ties broken by ID). This keeps ELK input stable so layouts are reproducible.
10. **Serialize:** canonical JSON. Keys sorted, arrays sorted by ID, no timestamps inside the graph (analysis time lives in metadata), `schemaVersion` set. Validated with Zod before writing.

**Determinism rules:**
- No `Date.now()` and no randomness in the graph.
- Every collection is sorted.
- Map iteration is never relied on for output order.
- The test analyzes each fixture twice and compares bytes.

## 6. Detector plugin interface

```ts
interface Detector {
  id: string;                      // "express-routes"
  appliesTo(service: ServiceContext): boolean;
  detect(ctx: DetectorContext): DetectorResult;   // pure, synchronous
}
interface DetectorResult {
  nodes: GraphNode[];              // routes, models, datastores, externals
  edges: GraphEdge[];
  unresolved: UnresolvedRecord[];  // with reason codes, never dropped
}
```

Every detector file starts with a doc comment listing **patterns handled** and **patterns not handled**. Examples:

**Express routes**
- **Handled:**
  - `app.get|post|put|patch|delete|all(path, ...handlers)`.
  - `router.METHOD(...)`.
  - `app.use(prefix, router)` mounting, including nested routers.
  - Imported routers across files.
  - `router.route(path).get(...)`.
- **Not handled** (recorded as unresolved):
  - Dynamically computed paths.
  - Routes registered in loops over runtime data.
  - Decorator frameworks (NestJS, v1.1+).

**Next.js routes** (ADR-0027)
- **Handled:**
  - `app/**/route.ts` exporting `GET|POST|…` ⇒ path from folders, mapping `[id]` ⇒ `:id`, `[...slug]` and `[[...slug]]` ⇒ `*slug`, and stripping `(group)` and `@slot`. Private `_folders` are skipped.
  - `pages/api/**` default exports ⇒ method `ALL` unless `req.method` checks are statically visible.
  - Pages: `app/**/page.tsx` and `pages/**` (minus `_app`, `_document`, `_error`) ⇒ `page` nodes with a `renders` edge to the default export.
  - `src/app` and `src/pages` when there's no root `app/` or `pages/`.
- **Not handled:** `next.config` (`basePath`, `pageExtensions`, rewrites, redirects; v1.1), intercepting routes, layouts and other special files, and middleware.

**Prisma**
- **Handled:**
  - `schema.prisma` (and multi-file schemas) models, views, fields, relations, `datasource.provider` ⇒ a datastore with `stores` edges.
  - Client usage `prisma.<model>.<op>`, where `create|update|upsert|delete*` are writes and `find*|count|aggregate|groupBy` are reads. The client is traced with the checker to `new PrismaClient()` or a `PrismaClient`-typed declaration (`exact`); untraced receivers named like a client (`db`, `tx`, `*prisma*`) are `heuristic`. Calls in inline Express handlers are attributed to the route.
  - Field-level reads from `select`/`include`/`where`/`data`/… object literals, as the edge's `fields`.
- **Not handled:** `$queryRaw` and friends (recorded as unresolved `RAW_QUERY`, model unknown); nested writes; delegates held in variables. Full list in `packages/analyzer/src/prisma.ts` (ADR-0028).

**HTTP clients**
- See §7.

**Queues** (`packages/analyzer/src/queues.ts`, ADR-0037)
- **Handled:** BullMQ `Queue`/`Worker`/`FlowProducer`, Bull, and Bee-Queue, traced like SDK clients (imports, workspace packages, class properties, factories with their parameters bound). `add`/`addBulk`/`upsertJobScheduler`/`createJob` and flow `queueName`s ⇒ `publishes`; `new Worker(name, processor)` and `queue.process(processor)` ⇒ `consumes` from the processor's symbol. Calls of worker factories bind the name per call. Every queue name is one `queue:infra/redis#<name>` node shared by producers and workers in any service.
- **Not handled:** NestJS `@Processor`/`@InjectQueue`, queues kept in maps or subclasses, publishing wrappers (their name parameter is `DYNAMIC_NAME`), sandboxed processor files, `prefix`/connection options, and other brokers' clients (amqplib, kafkajs, SQS). A name computed at runtime is an unresolved `DYNAMIC_NAME` node.

**Infra** (`packages/analyzer/src/infra.ts`, ADR-0036)
- **Handled:**
  - `docker-compose*.yml` / `compose*.yaml` services by image (`postgres`, `mysql`, `mongo`, `redis`, `rabbitmq`, `minio`, `elasticsearch`, etc.) ⇒ `datastore` or `queue` nodes, with override files in the same folder merged.
  - `.env*` URL keys: a Prisma datasource's `url = env("DATABASE_URL")` links its models' `stores` edges to the compose service the URL names (`exact`) or whose published port it uses on localhost (`heuristic`); other URL keys with a datastore scheme (`REDIS_URL=rediss://…`) that nothing else explains become env-only datastores.
  - Values are never stored. Only key names and URL schemes/hosts/ports are read; secrets are discarded at parse time, and hosts are only compared, never written.
- **Not handled:** `*_API_KEY` keys (SDK calls draw those edges), compose `extends`/`include`/`env_file`, images set from variables (warned), literal Prisma URLs, and other ORMs' connection settings.

## 7. Cross-service resolution algorithm

**Goal:** map each outbound HTTP call site in a frontend (or any service) to the route node it hits, with a confidence level.

### 7.1 Collect call sites
Implemented in `packages/analyzer/src/http.ts` (ADR-0030); its file comment lists every handled and unhandled pattern. A value that is set but can't be read statically (a runtime-built config, a method from a variable) is recorded as unknown, never defaulted.
- **`fetch(url, init?)`:** method from `init.method` if it's a string literal or resolvable const, else `GET`.
- **`axios.METHOD(url)`, `axios(config)`, `axios.request(config)`.**
- **Instances:**
  - `const api = axios.create({ baseURL })`, then `api.get(url)`. The instance is followed through imports via the TypeChecker, and `baseURL` is resolved the same way as URLs (§7.2).
  - Wrapper functions (`packages/analyzer/src/wrappers.ts`, ADR-0032): if `function get(path) { return fetch(BASE + path) }`, each call `get('/users')` becomes its own request, inlined one level deep with the wrapper's parameters bound to the caller's arguments (URL, axios `baseURL`, and method, including `{ method: "GET", ...init }`). Wrappers are symbols: functions, class methods, and the methods of an exported `const` object literal (`apiClient.get("/accounts")`, ADR-0159). A function that passes its own parameter on as the start of another wrapper's path (`getJson(path) { return request(path, { method: "GET" }) }`) is a wrapper too, up to three wrappers deep (ADR-0032's M5C.7f amendment): its callers are inlined through the chain, and the request is placed at the outermost call. A request whose URL still starts with a parameter of a caller that isn't followed (past the third level, no callers, or not a named function) is unresolved with reason `WRAPPER_DEPTH`. A wrapper with no visible callers keeps its own site, so no call site is dropped.

### 7.2 Normalize URL expressions to a pattern
Implemented in `packages/analyzer/src/url.ts` (ADR-0031); its file comment lists every handled and unhandled expression. A URL that starts with a runtime value is `DYNAMIC_URL`, with a readable detail.

Evaluate the URL expression into a sequence of **literal** and **hole** segments:

| Expression | Normalized |
|---|---|
| `'/api/users'` | `/api/users` |
| `` `/api/users/${id}` `` | `/api/users/{}` |
| `'/api/users/' + id` | `/api/users/{}` |
| `` `${API}/orders` `` where `const API = '/api'` (same or imported module) | `/api/orders` |
| `` `${process.env.NEXT_PUBLIC_API_URL}/orders` `` | `{env:NEXT_PUBLIC_API_URL}/orders` |
| `` `${API}/orders` `` where `const API = process.env.X ?? 'http://localhost:4000/api/v1'` | `{env:X}/api/v1/orders` (ADR-0158) |
| `` `/api/${process.env.VERSION \|\| 'v1'}/x` `` | `/api/v1/x` |
| `new URL('/x', base)` | `/x` relative to base |
| `cond ? '/a' : '/b'` (also held in a `const`), or a local `let` set to `/b` in an `if` | two requests at that call, `/a` and `/b` (ADR-0166) |
| `` `/x${page ? '?page=' + page : ''}` `` | `/x` (the alternatives read the same) |
| `buildUrl()` (unknown function) | unresolved, reason `DYNAMIC_URL` |

**Rules:**
- **Origin:** strip it if it's a literal (`https://api.example.com/...` ⇒ host recorded, path kept).
- **Env-prefixed bases:** treated as "same deployment" when the env var name is on a documented list of API-base names (`API`, `API_URL`, `API_PATH`, `API_HOST`, `BASE_URL`, `SERVER_URL`, `BACKEND_URL`, …, each alone or after a `PREFIX_`; the full list is `API_BASE_ENV_ENDINGS` in `match.ts`, ADR-0165) and the frontend and backend are in the same repo, or when the code's fallback for it is a loopback URL (`?? "http://localhost:9000"`, whatever the name). This yields **heuristic** confidence. A literal fallback's path follows the env base (ADR-0158). With no path in code, a committed example env file's value (`VITE_API_URL=http://localhost:5000/api` in `.env.example`) gives the path the matcher tries first, then the request alone; it's never written into the graph (ADR-0202, SECURITY.md T5).
- **Query strings and fragments:** dropped.
- **Trailing slashes:** normalized away.

### 7.3 Route patterns
Each route node has a method and a path pattern: `/api/users/:id`, `/files/*rest`. Express mounts are composed (`app.use('/api', r)` + `r.get('/users/:id')` ⇒ `/api/users/:id`). Next.js paths come from the file system.

### 7.4 Matching

Implemented in `packages/analyzer/src/match.ts` (ADR-0033); its file comment lists every handled and unhandled pattern. Base, method, and path each give a level and the weakest wins. At the best level, the best path alignment wins, then the request's own method beats `ALL`; ambiguity floors at `heuristic`.

For each call (method M, pattern P), compare with every route (method M', pattern R):

1. **Method must match:** `ALL` matches any method.
2. **Segment-wise match:**
   - A literal matches an identical literal.
   - A hole `{}` matches a param `:x`.
   - A literal matches a param, typed as a "possible" match.
   - Anything matches `*rest`.
3. **Score the match:**
   - **exact:** every call segment is a literal or hole aligned to the same literal or param, with no wildcard. The call's base resolves to the route's service (same host, relative URL within the same app, or a configured base literal).
   - **pattern:** matches, but needs a literal-to-param alignment or a wildcard.
   - **heuristic:** matches only after assuming an env-var base points at this backend, or the route is reached only through routers loaded from a folder listing (its filters aren't evaluated, ADR-0162).
4. **Ambiguity:** if more than one route matches at the best level, link to all of them with confidence downgraded one level, and record `AMBIGUOUS`.
5. **No match:** an `unresolved` edge to a synthetic `unresolved` node at the call site (the wrapper call when inlined), with a reason (`NO_MATCHING_ROUTE`, `DYNAMIC_URL`, `WRAPPER_DEPTH`) and a `detail` in words (ADR-0034).
   - A literal external host (`api.stripe.com`) instead creates or links an `external` node with an `external_call` edge, at exact confidence. Credentials and default ports are dropped from the host.

**UI:**
- Confidence becomes the border and line style: exact = solid, pattern = solid with a small marker, heuristic = dashed, unresolved = dotted.
- Unresolved calls are always shown, never dropped (fail visibly).

**Complexity:** calls × routes per repo, worst case about 2k × 500. Index routes by method + first literal segment to make it near-linear.

## 8. Graph diff algorithm (`packages/diff`)

**Input:** base graph and head graph (same schema version).

1. **Node identity:** IDs are qualified names (ADR-0019), so most nodes match by ID.
2. **Rename and move detection** (`detectRenames`, ADR-0086): among base nodes missing in head and head nodes new in head, of the same kind, one to one. File text comes from the caller (`contents`); without it, only identical files match.
   - **Files:** identical hash, or content similarity (Jaccard over 4-token shingles, ≥ 0.6, files of 50+ tokens).
   - **Modules:** a folder most of whose files moved into one new folder.
   - **Symbols:** the same name under a renamed file or class with body similarity ≥ 0.8, or a body equal token for token (own name masked, 20+ tokens) that's unique on both sides.
   - **Unresolved nodes:** the same call in the same (or moved) file, paired in source order.
   - Ties are left unmatched, never broken by guessing. Each match is a `renamed` pair, and edges are remapped through it; a node whose parent was renamed is `updated`, not `modified`.
3. **Classify:**
   - **Nodes:** `added`, `removed`, `modified` (same ID, different fingerprint: e.g. a file's hash, a route's method/path, a model's fields; per-kind table in ADR-0085), `updated` (same ID and fingerprint, other facts such as a source line differ), `renamed`. A symbol's only signature fact is its required parameter count (ADR-0088), so body changes show through its file's hash.
   - **Edges:** `added`, `removed`, `modified` (confidence, label, reason, or fields), `updated` (call sites only), `renamed`.
4. **Broken edges:** a head edge E from S to T is **broken** if S exists in head and still references T, but T is removed in head, or T is modified incompatibly. Incompatible means:
   - A route's method or path changed.
   - A function's required parameter count increased.
   - A model field read by S was removed.

   Also check base edges whose target was removed but whose source in head still contains the same call site. Detect this by re-running the resolver on head and finding unresolved calls whose base resolution pointed at the removed target.
   - **How (`detectBroken`, ADR-0087):** head's analyzer already turned such calls into `unresolved` nodes, so the diff re-resolves each one from the (possibly renamed) source against the removed base target: an HTTP call's method and path against the route (the route grammar shared through `@gitinside/schema`), a relative import specifier against the file's path, a Prisma accessor against the model's name. A removed route whose handler now serves a new route is `ROUTE_CHANGED`; otherwise `TARGET_REMOVED`. A target that head renamed or moved (a file moved to another folder) is re-resolved the same way, at its base path, for each caller whose edge didn't follow it: one still asking for the old place is `TARGET_MOVED` ("src/util.ts is now at src/lib/util.ts").
   - **Changed but present targets (ADR-0088):** the analyzer records each TypeScript symbol's `requiredParams`, each call site's argument count (`args`), and the names a Prisma call uses that its model lacks (`missingFields` on the site). A surviving `calls` edge is `PARAMETERS_ADDED` when the count rose and a head site passes the old count but not the new one; a surviving `reads`/`writes` edge is `FIELD_REMOVED` when a head site names a field base's model had and head's lacks. Only the offending sites are listed.
   - **Calls to removed symbols (ADR-0087's M7.2e amendment):** an unresolved call makes no node, so the evidence is the import. The analyzer lists on each `imports` site the names the import asks for that the file doesn't export (`missingExports`; an emptied file exports nothing). A base `calls` edge to a removed symbol is `TARGET_REMOVED` when head's import from the caller's file of the symbol's file still asks for the symbol's exported name (a method's: its class's), and those import sites are listed.
   - Calls to removed functions with no import of their name left (globals, namespace imports, re-exports from another file, a named default export imported as `default`), symbols that stay but stop being exported, aliased imports, queue/page/external edges, JavaScript parameters, overloads, and type-only changes aren't detected.
5. **Output:** a `GraphDiff` (GRAPH_SCHEMA.md): head records for added, changed, and renamed items, base IDs for removed ones, broken edges, and summary counts, so the diff alone rebuilds head from base (ADR-0084). Diffs are sorted and deterministic (`stringifyDiff`).
6. **Mermaid summary** (`renderMermaidSummary`, ADR-0089), for `gitinside diff --format mermaid` and the PR comment: a `flowchart LR` of broken connections first (source to base target), then changed services, routes, pages, models, datastores, queues, and external hosts, then changed cross-boundary edges (`http`, `reads`, `writes`, `stores`, `publishes`, `consumes`, `external_call`) lifted to the nearest drawn node and merged per pair. The change is in words ("Removed", "Renamed from …") and in a colored, for removals dashed, border. At most 40 nodes, the rest counted in a note. A method is named with its class (`method DocumentInterpreter.parse`), and a method renamed within its class says only its old name ("Renamed from parse"). Two nodes that would read the same name their service (else their declaring file). Labels are cut at 60 characters and every character outside `[A-Za-z0-9 ._,()/:@-]` is written as a `#<code>;` entity (SECURITY.md T10).
7. **PR comment and Check Run text** (`renderPrComment`, `renderCheckRun` in `packages/diff/src/pr.ts`, ADR-0243): pure and deterministic, from the diff and both graphs. The comment opens with a hidden marker (`<!-- gitinside:pr-comment -->`) for finding it again, then the broken count, each broken connection (source → base target, the reason in the broken pill's words, the analyzer's detail, up to 5 head call sites linked at the head commit on GitHub, the rest counted), the Mermaid summary in a `mermaid` block, the rename budget's note when `renameLimit` is set, and the link to the interactive diff (`/<owner>/<repo>/<head>?base=<base>`). The Check Run is named `GitInside`, titled with the broken count, its summary the same list without the diagram, and concludes `neutral` with breaks (reviewers see it; the PR isn't blocked), `success` without. Both fit GitHub's limits (65,536 characters for a comment, 65,535 for a summary): the first broken connections that fit are listed and the rest counted, and a diagram too large to fit at all is replaced with a note. Repo text is written only in Markdown code spans (control and format characters removed, whitespace collapsed, cut at 160 characters) or percent-encoded in links (SECURITY.md T10).

**Properties (fast-check):**
- `diff(g, g)` is empty.
- `apply(base, diff(base, head)) == head`.
- `added(diff(a, b)) == removed(diff(b, a))`.
- Broken edges never point to nodes that exist unchanged in head.
- The diff doesn't depend on the order of nodes, edges, sites, or warnings in its inputs.
- The viewer's overlay accepts every diff (`packages/viewer/src/model/diff.properties.test.ts`, M6.11g): `buildDiffOverlay` never throws, its graph is valid, each version is a tree holding that version's nodes, and every added or removed node is listed as a row or folded into one.

`packages/diff/src/testkit.ts` (exported as `@gitinside/diff/testkit` for the viewer's tests) builds base/head pairs from a fixed universe of node slots read off one choice vector, head being base's vector with 5–30% of the choices replaced, so pairs share most IDs and include renames (by hash and by content), changed route methods, and calls that became unresolved. A seeded check that the sampled pairs reach every broken-edge reason keeps the properties from passing vacuously.

**Layout stability:** the viewer lays out head with base positions pinned for nodes that exist in both, and only new nodes are placed (ELK `interactive` layering with fixed positions).

## 9. Incremental analysis

Built in steps M6.7a–f (ADR-0090).
- **Unit of reuse:** a service's facts: what each program stage (symbols, imports, calls, Express, Next.js, Prisma usage, HTTP requests before matching, SDKs, queues) found in that service's files, in serializable form, namespaced by `(schemaVersion, analyzerVersion)`.
- **Validation by observed inputs:** each entry lists every repo path the service's program and detectors read or probed, with its content hash (SHA-256) or "absent", including other services' files reached through workspace imports. An entry is reused only if every input still answers the same, so a changed, added, or deleted file invalidates every service that read or looked for it: its own, its importers' (transitively), and dependents in other services. Direct-importer invalidation alone could let a warm run differ from a cold one, since checker facts follow types through transitive imports and Express mounts compose routes from importer files.
  - Recorded by each service's own compiler host (`packages/analyzer/src/inputs.ts`, ADR-0091): files read (hash), files probed (`present`/`absent`), folders probed, and the service's root-file listing (so an added file counts). Other services' programs a service's analysis reached through the symbol resolver add their inputs transitively. `createInputVerifier` answers the first input that changed.
  - Global inputs are part of the cache key instead: the workspace layout, inventory limits, TypeScript's bundled libs (its version), and whether the repo uses Prisma. Each service's key also holds its own files' hashes, so two versions of a service keep separate entries (`packages/analyzer/src/incremental.ts`, ADR-0175).
- **Reuse (`analyze({ cache })`, `--cache <dir>`):** when every service's entry verifies, the graph is composed from cached facts with no program built (ADR-0175). Otherwise the services whose entries verify are reused and the rest collected (ADR-0176). Each entry also records the repo-wide facts it was collected under (whether any service creates a router or names a queue library, every wrapper's ID); a reused entry collected under different ones makes the run start over with that service collected. A failed collection or a TypeScript internal error makes it start over cold. Only the collected services' bundles are stored, never one with a failed collection.
- **Lazy programs:** a program is parsed on first use (ADR-0177). A partial run parses the collected services' programs. It parses a reused service's program only when a collected service's analysis needs it: an import into it, a symbol declared in one of its files, a call to one of its wrappers, or an axios `defaults` write in a file the request reaches. A reused service's part of the repo-wide facts comes from its entry.
- **Always recomputed:** route matching, wrapper binding, the Prisma schema, infra, file nodes, and assembly; they're cheap compared with parsing. A clean service's program is built only if a dirty service's checker needs it.
- **Storage:** a local disk cache (`openDiskCache`, `packages/analyzer/src/cache.ts`): gzipped JSON entries named by key hash, atomic renames, LRU by file time, room made before each write so the folder never passes its cap, failures counted and treated as misses. The CLI's default cap is 2 GB. For PR diffs, base and head share entries for unchanged services.
- **On the worker** (`apps/worker/src/factcache.ts`, ADR-0178): the cache lives in Cloud Run's in-memory `/tmp/cache` and lasts as long as the instance. `public/` holds public repos' facts and `installations/<id>/<repo row ID>/` each installed repo's (deleted by every job's start once the repo is no longer linked to that installation, ADR-0242); a private repo without an installation gets none. The sandboxed child may read and write only its job's folder. All folders share one 64 MiB cap, counted in 4 KiB pages and taken from the memory budget (two cal.com-sized analyses: 25.2 MiB each when measured, `bench/results/2026-11-02-cache-sizes.md`; since ADR-0180/0181 store each inputs set once, the M6.8c2 benchmark's cal.com cache took 1.9 MiB after filling and 4.1 MiB after ten commits, counted in bytes rather than pages); before a job, other folders are deleted whole, least recently used first, until they hold at most half, and the job's folder gets the rest.
- **Budgets** (measured in `bench/`):
  - Full analysis of a 5k-file repo ≤ 60 s on the worker (one Cloud Run instance, 1 vCPU / 4 GiB). **Not met yet:** M5.13 measured 96.3 s from queued to done for cal.diy's 5,075 files (documenso, 2,260 files: 47.3 s; `docs/milestones/M5-review.md` → Smoke test). Where it goes (M5.13a2, `bench/results/2026-11-04-caldiy-stages.md`): 61% of the analysis's CPU is TypeScript and 12% the garbage collector, the analyzer's own code under 15%; building the 113 service programs is the largest stage, and each repo file is parsed 1.48 times across them (no shared source files or module-resolution cache). On a 1-vCPU container of the worker image in CI (M5.13a3, `bench/results/2026-11-04-cloudrun-caldiy.md`; the laptop's runs of the same commit range 48–92 s) the analysis itself takes 44.2–44.4 s over 3 runs, plus 3.1 s of extraction, CPU-bound throughout, so the rest of production's 96.3 s is dispatch, cold start, download, upload, or a slower vCPU. Each file is now parsed once per parse setting (ADR-0197: 1.08 parses per file, heap −173 MiB on 1 vCPU, time within runner noise); a shared module-resolution cache was measured slower and larger and not merged (ADR-0197 amendment, `bench/results/2026-11-04-caldiy-m5.13a4b-resolutions.md`). The collector's main-thread pauses are 14–17% of the analysis on one vCPU, almost all of them minor. A 32 MiB semi-space (twice V8's) cuts them by 15–23% but the analysis by only 0.2–1.0 s, and it's kept (ADR-0198, `bench/results/2026-11-04-cloudrun-caldiy-m5.13a5.md`). **The analysis alone now meets the budget** on all four CI CPU models measured: 33.7–58.5 s median, though EPYC 7763 leaves only 1.5 s of margin. **End to end in production it isn't met yet.** Production's own split for cal.diy (gitinside-planning#20, `bench/results/2026-11-04-caldiy-stages.md` → Production's split): 92.7 s from queued to done, of which 0.6 s dispatch (an instance was already up), 9.5 s download, 81.6 s analysis, 1.4 s upload. Every stage ran 1.6–2.0× slower than on CI's 1-vCPU runner (1.84× for the analysis) with the same graph, so the gap is the CPU Cloud Run gave the job. Those rows predate ADR-0197 and ADR-0198; production's next cal.diy analysis (after the next `ANALYZER_VERSION` bump) measures the current code there.
  - Incremental re-analysis after a 10-file change ≤ 10 s. **Not met** (M6 review): on cal.com's 10 real consecutive commits (laptop, `bench/results/2026-11-02-incremental-calcom-commits-m6.8c2.md`), the nine that change source re-collect 88–90 of 113 services, because they touch `packages/lib`, which nearly every service imports, and take 34.9–36.4 s warm against 34.6–36.3 s cold (0.96–1.01×). Only a commit that changes no service's inputs (5.27×, 6.6 s) or a leaf app's edit (`…-incremental-calcom-m6.8c2.md`: 2.8×, 12.6 s) gains. The cache skips unchanged services; it doesn't make re-collecting one cheaper.

## 10. Data model (Postgres, Drizzle)

| Table | Key columns |
|---|---|
| `repos` | id, provider_repo_id, owner, name, visibility (`public`/`private`), installation_id (nullable), default_branch |
| `analyses` | id, repo_id, sha, status (`queued`/`running`/`done`/`failed`), error_code, stats (jsonb: files, nodes, edges, unresolved), snapshot_key, analyzer_version, started_at, finished_at. Unique (repo_id, sha, analyzer_version). Also the job (ADR-0139): job_id (`analyze-<32 hex>`, indexed), attempts, queued_at (queue position), progress (jsonb, only while `running`) |
| `users` | id, github_user_id, login, created_at |
| `sessions` | id, token_hash (SHA-256 of the cookie's token, unique), user_id, github_tokens (sealed by the website), created_at, expires_at. Deleted on sign-out and with the user (ADR-0221) |
| `installations` | id, github_installation_id, account_login, created_at |
| `access_cache` | user_id, repo_id, allowed (bool), checked_at. Primary key (user_id, repo_id); TTL 60 s (ADR-0009) |
| `pull_requests` | id, repo_id, number, base_sha, head_sha, head_at (GitHub's `updated_at` in the event that set them), diff_key, broken_count (set together), diff_job_id, diff_queued_at (the pair's diff job and its task's time, set together, cleared with the pair; ADR-0245), comment_id, check_run_id. Unique (repo_id, number); an older event or an old pair's result never overwrites a newer one (`packages/db/src/pullRequests.ts`, ADR-0244) |
| `rate_limits` | key (ip or user), window_start, count |
| `store_requests` | month_start (UTC), source (`worker`/`web`), count. Primary key (month_start, source); bucket requests against Oracle's 50,000 a month (ADR-0096) |
| `compute_usage` | month_start (UTC, primary key), instance_ms, run_requests, task_operations. Google compute used this month, counted by the worker (startup + shutdown allowance, each push's time) and the website (each Cloud Tasks create); new analyses pause at 80% of the free allowance (ADR-0156) |
| `maintenance_runs` | name (primary key, `hourly`), started_at. When the worker's maintenance last started, claimed by one instance at a time (ADR-0147) |

- **Implementation:** `packages/db` (ADR-0057). IDs are random UUIDs; GitHub IDs are `bigint`; every table has `created_at`, and `repos`/`pull_requests` also `updated_at`. The database itself enforces SHAs (40 lowercase hex), the status ⇔ columns rule for `analyses` (`done` has a snapshot, `failed` an error code, both a finish time), non-negative counts, owner/name unique ignoring case, and cascading deletes from repos and users. Migrations are committed SQL under `packages/db/drizzle/`, applied by the worker at startup before it listens (under a Postgres advisory lock, through Neon's direct endpoint, ADR-0192), so production's schema is never behind a deployed worker; `pnpm --filter @gitinside/db migrate` does the same by hand (local development).
- **Writes** (ADR-0063, `packages/db/src/analyses.ts`): the worker upserts the repo from GitHub's own facts (ID, current name, visibility, default branch) and marks the analysis `running` at the start of each attempt, `queued` after an attempt that will be retried, `failed` after the last one, and `done` only after the snapshot is in the bucket. A `done` row is never changed again. At startup and in its hourly maintenance the worker fails rows `running` for over 360 s, left by a dead instance (`JOB_INTERRUPTED`), and the maintenance also fails rows `queued` for over a day and 10 minutes, which no task can still run (`QUEUE_UNAVAILABLE`, retryable; ADR-0147). Each start stores the job ID and counts the attempt, and while it runs the worker writes each progress update to the row (`recordJobProgress`, `packages/db/src/jobs.ts`); `findJob` reads a job by ID with its queue position (ADR-0139).
- **Snapshot retention** (fits Oracle Object Storage's Always Free 20 GB, ADR-0095; it replaced R2, PROPOSALS P-2): keep the latest 5 SHAs per public repo plus any SHA referenced by a PR from the last 30 days. Evict the oldest first, globally, when usage passes 16 GB.
  - **Implementation** (ADR-0077, `apps/worker/src/retention.ts`): a pure `planRetention` over the `done` rows, the bucket's own listing (what the free tier counts), and the pinned commits. Per public repo, each kept commit keeps only the analysis its permalink serves (older analyzer versions are `superseded`). Past 16 × 10⁹ bytes the oldest unpinned snapshots go, private ones included. Objects no row names are deleted after an hour. A run deletes rows before their objects, so a failure leaves an orphan for the next run, never a row without its graph. (Until M5.17c3 it also removed each deleted row's completed BullMQ job, ADR-0082; the job is now the row itself.)
  - **Schedule and quota check** (ADR-0078, ADR-0147, `apps/worker/src/maintenance.ts`): Cloud Run gives an instance CPU only during a request, so there is no timer: at the end of a job, before answering its push, an instance with at least a minute of the job's budget left claims the run in `maintenance_runs` (one statement on the database's clock; only if the last run started an hour or more ago, so one of two instances wins), and waits for it at most the job's time left. A run fails stale job rows (above), runs retention, prunes `rate_limits` windows that ended over an hour ago, and measures the bucket (a fresh listing), the database (`pg_database_size`), and the month's bucket requests (`store_requests`, counted by the worker and the web app through `countingFetch`, ADR-0096) against Object Storage's 20 GB and 50,000 requests a month and Neon's 1 GB, and the month's Google compute (`compute_usage`) against Cloud Run's free 180,000 vCPU-seconds, 360,000 GB-seconds, and 2 million requests and Cloud Tasks' 1 million operations (ADR-0156). At 80% it logs `quota_alarm` (for compute, new analyses are then paused until the next UTC month); `pnpm --filter @gitinside/worker quota` prints the same check and exits 2 on an alarm.
- **Private data:** stored under the installation prefix and deleted on uninstall.

## 11. API

| Method + path | Purpose |
|---|---|
| `POST /api/analyze` `{ url }` | Resolve the repo and latest SHA. Return the existing analysis (`200 { status: "done", owner, repo, sha }`), or enqueue (`202 { status: "queued", jobId, … }`). Only new analyses are rate-limited (5/h per IP signed out, 30/h signed in); a commit in flight gets its job back free. A repo whose analysis hit a `LIMIT_*` limit in the past 7 days gets no new analyses unless GitHub's `size` has halved (`apps/web/lib/sizeHold.ts`, ADR-0153; check-on-view shows the last diagram instead). A repo with over 100 MB of TypeScript and JavaScript by GitHub's languages count (twice the 50 MB source limit) is refused before any download (`apps/web/lib/codeSize.ts`, ADR-0154; GitHub's `size` is mostly history and can't tell cal.com from VS Code). A repo gets at most one new analysis per 30 minutes whoever asks: the first new commit claims the repo's row, other commits are refused until the claim ends (`claimRepoAnalysis`, ADR-0155). While the month's Google compute is at 80% of the free allowance, no new analysis starts until the next UTC month (`findComputePause`, ADR-0156; check-on-view shows the last diagram, `paused`). Errors: `{ error, message }` (`INVALID_URL`, `REPO_NOT_FOUND` incl. private, `REPO_EMPTY`, `REPO_TOO_BIG` (422), `REPO_RATE_LIMITED` (429), `ANALYSIS_PAUSED` (503, `retryAt`), and `RATE_LIMITED` with `retryAt`, `UNAVAILABLE`, …). Enqueuing is `enqueueAnalysis` (`apps/web/lib/enqueue.ts`, ADR-0141): the `queued` row first (job ID from the worker's `jobIdFor`, `@gitinside/worker/request`), then a Cloud Tasks task named `<job ID>-<queued_at ms>` (none for a row `queued` for its task's retry, ADR-0141's amendment); if the task can't be created, the row this request queued is failed with `QUEUE_UNAVAILABLE` (retryable) and the answer is `UNAVAILABLE`. `apps/web/lib/analyze.ts`, ADR-0066 |
| `GET /api/jobs/:id` | The job as the progress page shows it: `{ state: "queued", text: "2 ahead of you", position? }`, `{ state: "running", step, progress, text: "Parsing 1,204 files" }`, `{ state: "done" }`, `{ state: "failed", errorCode, message, retry }`, `missing` (404, also a private repo's job until M8), `unavailable` (503). Read from the job's `analyses` row (`findJob`, ADR-0139), never from the worker: the progress is checked with the worker's `parseRecordedProgress`, and the time left is what the worker wrote minus the row's age, both on the database's clock (ADR-0140). SSE variant at `/api/jobs/:id/events`: `event: status` on each change (one row read a second), ends after 25 s or a final state, and `EventSource` reconnects. Page: `/<owner>/<repo>/jobs/<jobId>`. `apps/web/lib/jobs.ts` + `jobRoute.ts`, ADR-0067 |
| `GET /api/graph/:owner/:repo/:sha` | Snapshot: the newest finished analysis of that commit, streamed from the snapshot bucket as JSON (public: `public, max-age=300, s-maxage=86400`, cached by Vercel's CDN; private: the session's access check (ADR-0231) before the redirect or the bucket, then `private, no-store`, `Vary: Cookie`; signed out or refused ⇒ the missing graph's exact 404, a check that can't decide ⇒ 503, ADR-0232). Bad names or a short SHA ⇒ 404 before any lookup; another spelling of the repo ⇒ `308` to the stored one before any bucket read (cached 1 h, ADR-0097); storage down ⇒ 503. `apps/web/lib/graphRoute.ts`, ADR-0068 |
| `GET /api/source/:owner/:repo/:sha/*path` | A private repo's file at an analyzed commit, for its code preview (public repos' previews read `raw.githubusercontent.com` in the browser, ADR-0115). Only a commit with a stored analysis of a private repo, after the session's access check; read from GitHub by repo ID with the viewer's token (`/repositories/{id}/contents/…?ref=`, raw). Public, unknown, unanalyzed, signed out, or refused ⇒ the same 404; undecided or GitHub failing ⇒ 503; over 2 MB ⇒ 413. Every answer `private, no-store`, `Vary: Cookie`; files as `text/plain`, `nosniff`, `default-src 'none'; sandbox`. `apps/web/lib/sourceRoute.ts`, ADR-0237 |
| Page `/<owner>/<repo>[/<sha>]` | Check-on-view (`lib/repoView.ts`, ADR-0068): the newest finished analysis; without a SHA, GitHub's latest commit (remembered 60 s) is compared and a new one enqueued (`enqueueAnalysis`; a row whose task was never created, `QUEUE_UNAVAILABLE`, is queued again rather than shown as failed), charged to the repo (`repo:<id>`, 6/h), not the visitor. A repo GitHub no longer shows publicly is a 404. Not analyzed ⇒ an Analyze button; ready ⇒ a repo bar (commit, latest-commit status) and the graph fetched from `/api/graph` and schema-checked in the browser (`app/[owner]/[repo]/`, ADR-0069) |
| `GET /api/diff/:owner/:repo/:base...:head` | Diff for the viewer |
| `GET /api/badge/:owner/:repo.svg` | README badge, "GitInside \| 3 services · 2 datastores" (`badgeMessage`). Check-on-view through `viewRepo` (a new commit is enqueued, charged to the repo) while the newest finished diagram is shown, its graph fetched from our own day-cached `/api/graph` URL, never the bucket (ADR-0097). Cached 10 min (`public, max-age=600, s-maxage=600`). No diagram (never analyzed, private, gone, impossible name) ⇒ the same link-only badge, "view architecture"; a failure on our side ⇒ that badge for 1 min, never a 5xx. Served with its own CSP (`default-src 'none'; style-src 'unsafe-inline'; sandbox`). `apps/web/lib/imageRoute.ts`, ADR-0072 |
| `GET /api/diagram/:owner/:repo.svg[?theme=dark\|light]` | Live README image: the top level as SVG (`renderDiagram`; `auto` follows the reader's system, `<picture>` asks for one theme). Same check-on-view, caching, link-only fallback, and CSP as the badge. ADR-0072 |
| `POST /api/github/webhook` | `pull_request`, `push`, `installation`, `installation_repositories` (HMAC-verified). `pull_request` `opened`/`synchronize`/`reopened` from a stored, unsuspended installation: the repo stored and linked, the pair recorded (`recordPullRequestHead`), and for a current pair without a diff one `diff` task (`{ kind: "diff", owner, repo, sha: head, baseSha, installationId }`) named from the record's `diff_queued_at`; no queue or a refused create ⇒ `503` (GitHub doesn't retry; "Redeliver" recreates the same task name). `apps/web/lib/githubWebhook.ts`, ADR-0245 |
| `GET /api/auth/github/callback` | OAuth (identity only) |

**Worker (Cloud Run; `apps/worker/src/run.ts`, ADR-0143):** only Cloud Tasks' service account may call it (Cloud Run IAM), and each job is also HMAC-signed by the web app.
- `POST /run` `{ kind: 'analyze' | 'diff', owner, repo, sha, baseSha?, installationId? }` (the task's body) → `200 { status: "done" | "failed", … }` when no retry should follow, `503` for a retriable failure with attempts left, `429` while busy, `401`/`400`/`413`/`415` for a request refused before it runs. The job ID is derived from the body and the analyzer version (`jobIdFor`; a job read through an installation adds its `installationId`, so it's never a public job's, and public IDs are unchanged, ADR-0227); the attempt from `X-CloudTasks-TaskRetryCount`. While a job runs, its progress goes to its `analyses` row: the stage, and in `analyze` the analyzer stage running (`step`) and its size when known (`count`: source files for `programs`, requests for `http`); `describeProgress` in `@gitinside/worker/progress` turns them into the progress page's words ("Parsing 1,204 files", ADR-0064).
- `GET /health` (unauthenticated) → `{ status: 'ok' }`
- Signed with `X-GitInside-Timestamp` + `X-GitInside-Signature: v1=<hex>` (`@gitinside/worker/hmac`), accepted for a day so a task can wait in the queue.
- (Until M5.17c3 the VM's worker also served an HMAC enqueue API, `POST /enqueue` and `GET /jobs/:id`, in front of BullMQ on Redis, ADR-0060, ADR-0061. Both are gone.)

## 12. Failure modes and limits

| Situation | Behavior |
|---|---|
| Dynamic routes, DI, reflection, routes built in loops | Not guessed. Recorded as unresolved with a reason, and visible in the UI |
| Over 20k files / 50 MB of source / 5 min / 400 MB unpacked | Fails with `LIMIT_*`; the UI suggests a subfolder (`?path=apps/web`) |
| Missing or invalid tsconfig | Synthesized defaults (§5.3); warning in stats |
| Syntax errors in a file | The file is parsed with errors; the TS AST is still traversed; warning recorded |
| Monorepo with circular workspace deps | Services are still created; cycle warning |
| Worker crash mid-job | The push gets no answer, so Cloud Tasks delivers it again (one of its 3 attempts). The row left `running` is failed with `JOB_INTERRUPTED` once it's older than any request can live (360 s), at the next startup or maintenance run (ADR-0144, ADR-0147). A shutdown cancels the running job (`CANCELLED`, answered 503), which is then delivered again |
| Transient failure (GitHub down, rate limit, storage) | Answered 503, so Cloud Tasks retries with its backoff, 3 attempts; after that the row is `failed` with a retryable code, and asking again queues it anew (ADR-0143) |
| A task never created (the web function died between the row and the task) | The row stays `queued`; maintenance fails it with the retryable `QUEUE_UNAVAILABLE` once no task could still run it (a day and 10 minutes), and the next view queues it again (ADR-0147) |
| GitHub API rate limit | Back off; use the installation token for private repos and the app-level token for public ones |
| Free-tier quota close to the limit | Retention eviction (§10); a `needs-abhinav` issue at 80% |
| Google compute at 80% of the month's free allowance | New analyses pause until the next UTC month ("Analysis is paused until …"); diagrams, badges, and images keep working (ADR-0156) |

## 13. Observability

- **Logs:** structured JSON logs from the worker, one event per line on stdout (`createJsonLog`, ADR-0065), collected by Cloud Logging (inside its free monthly allowance). Codes, IDs, counts, and timings only; never a secret or connection string.
- **Per-analysis timing** for each pipeline stage, stored in `analyses.stats` (feeds benchmarks).
- **Health endpoint** on the worker (`GET /health`, for Cloud Run's probes).
- No third-party telemetry ($0, privacy).
