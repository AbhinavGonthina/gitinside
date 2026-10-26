# Architecture decision records

One entry per significant decision: context, options, decision, consequences. New ADRs are appended with the next number. An ADR is never edited after the fact except to mark it **Superseded by ADR-NNNN**.

Product-level decisions trace to `../gitinside-planning/DISCOVERY.md` (`D<topic>.<n>`) and `../gitinside-planning/SPEC.md`.

---

## ADR-0001: Website first, GitHub App second, both in v1
- **Context:** the paste-a-URL website is the front door; the PR bot drives retention. Abhinav wants both in v1 (D1.1).
- **Options:**
  - Website only in v1.
  - Both in v1, website built first.
  - PR bot first.
- **Decision:** both are in v1. Build order is the website flow (M1–M5), then diff (M6–M7), then sign-in and the GitHub App (M8).
- **Consequences:**
  - The PR bot reuses the analyzer, diff, and viewer instead of shipping a Mermaid-only bot early.
  - Private repos arrive late (M8).

## ADR-0002: One stack, done well
- **Context:** supporting every language is startup-scale. Accuracy numbers matter more than breadth (D1.4, D2.1).
- **Options:**
  - Core TS set.
  - Full KICKOFF TS set (+TypeORM, k8s, Terraform).
  - TS + Python.
- **Decision:** v1 supports TypeScript/JavaScript only.
  - React/Next.js frontends.
  - Express and Next.js API route backends.
  - Prisma.
  - docker-compose and `.env`.
  - Monorepos via npm/yarn/pnpm workspaces and Turborepo/Nx (D2.3).
  - Detectors sit behind a plugin interface.
- **Consequences:**
  - TypeORM, Kubernetes, Terraform, tRPC, GraphQL, and other languages are v1.1+.
  - The detector interface must not assume TS internals at its boundary.

## ADR-0003: Structure is deterministic; no LLM in v1
- **Context:** if an LLM decides structure, diagrams change between runs and can't be trusted (ORIGINAL_ANALYSIS). Abhinav chose no AI in v1 (D3.3), and the budget is $0 (D8.2).
- **Options:**
  - LLM summaries only.
  - Summaries plus "Explain this".
  - No LLM.
- **Decision:** no LLM anywhere in v1. Nodes, edges, labels, and groups come from parsing and heuristics: names, folders, framework conventions, and dependencies. Same commit ⇒ byte-identical `architecture.json`.
- **Consequences:**
  - The determinism test is mandatory.
  - Inspector summaries are templated from graph facts.
  - The pitch "everything shown comes from code" is literally true.
  - AI features (v1.1) need a budget decision first (D9.1).

## ADR-0004: Real static analysis with source links
- **Context:** competitors (GitDiagram, Eraser) have a model read files and draw a diagram (D6.5).
- **Decision:** every node and edge carries a source location (file, line, column) and links to GitHub at that line. Cross-service edges come from resolving actual call sites.
- **Consequences:** the schema requires `source` on every node and edge kind except synthetic group nodes, which aggregate their children's locations.

## ADR-0005: Hierarchical, C4-style drill-down
- **Context:** large graphs become hairballs, and readability matters more than completeness.
- **Decision:**
  - Hierarchy: System → Services → Modules → Files → Symbols.
  - The top level never shows more than one node per service, datastore, and external system.
  - Children appear only when their parent is expanded.
- **Consequences:**
  - Every node has exactly one `parentId`, except the system root.
  - Edges are stored between leaves and aggregated upward at render time.

## ADR-0006: Broken-edge detection is the flagship check
- **Context:** the most valuable PR signal is "this PR removes or changes something another part still uses."
- **Decision:** the diff marks an edge `broken` when its target is removed or changed incompatibly in head while the source still references it. Covered cases:
  - Route removed or method/path changed.
  - Symbol removed or renamed without updating callers.
  - Prisma model field removed while still read.
- **Consequences:** node identity must be stable across commits (ADR-0019), and the diff needs a property-test suite.

## ADR-0007: Untrusted repos are parsed, never executed
- **Context:** anyone can submit any public repo.
- **Decision:**
  - Never install dependencies, run scripts, or evaluate code.
  - Analysis runs in a hardened container: non-root, read-only filesystem except a temp dir, network only to GitHub.
  - Each job is a child process with memory, CPU, and wall-clock limits.
  - Limits: 20k source files, 5 minutes (D2.2, D5.8). Symlinks and path traversal are rejected at extraction.
- **Consequences:** no type information from `node_modules`, so external library types resolve to `unknown` (documented per detector). Security tests are required (`docs/SECURITY.md`).

## ADR-0008: Measurement is part of the product
- **Context:** resume impact and credibility depend on real numbers (D1.4).
- **Decision:** ship the accuracy eval (5 labeled repos, precision/recall), PR backtesting (~8 repos), incremental-analysis speedup, and render/analysis benchmarks. Results are committed and reported exactly as measured.
- **Consequences:** M3 comes right after the resolver (ADR-0016). Labels are independently drafted and spot-checked by Abhinav (D10.3).

## ADR-0009: Access model
- **Context:** public use must be frictionless; private repos must be safe (D7.1–D7.4).
- **Decision:**
  - Public repos: no sign-in, cached by commit SHA, shareable links.
  - Private repos: an optional GitHub sign-in plus a GitHub App installed on chosen repos. Permissions:
    - Contents: read. Metadata: read.
    - Pull requests: read & write (comment only).
    - Checks: read & write (Check Run only).
  - Private views re-check access, cached for at most 60 seconds per user+repo. Private data never enters the public cache, and uninstall deletes it immediately.
- **Consequences:**
  - Public copy says "read-only access to your code", not "read-only".
  - Access checks need a small cache table.
  - The uninstall webhook handler is security-critical and tested.

## ADR-0010: TypeScript compiler API for parsing and resolution
- **Context:** cross-service matching needs real name resolution (imports, path aliases, axios instances) (D5.1).
- **Options:**
  - TS compiler API.
  - tree-sitter only (we'd write resolution ourselves).
  - Both.
- **Decision:** use the TypeScript compiler API (`typescript` package, `ts.createProgram` with `noResolve` off but no `node_modules` on disk) for parsing, binding, and symbol resolution.
- **Consequences:**
  - Memory grows with repo size, which drives the 20k-file limit and per-package programs for monorepos.
  - A tree-sitter plugin path stays open for other languages.

## ADR-0011: React Flow + ELK renderer
- **Context:** the UI must look premium, and nodes need rich content (D5.2, D6.1).
- **Options:**
  - React Flow + ELK.
  - Sigma.js WebGL.
  - Custom PixiJS.
- **Decision:** React Flow with custom React node components. ELK.js runs layout in a Web Worker, with viewport culling.
- **Consequences:**
  - Drill-down must keep visible nodes ≤ ~2,000.
  - The 60fps target is benchmarked in M4b.
  - A WebGL fallback is added only if benchmarks fail.

## ADR-0012: Next.js web app in a pnpm + Turborepo monorepo
- **Context:** one deploy for pages and API; shareable SSR diagram pages; dogfooding (D5.3, D5.4).
- **Decision:**
  - `apps/web` is Next.js (App Router) with route handlers for the API and GitHub webhooks.
  - The monorepo uses pnpm workspaces + Turborepo with packages `schema`, `analyzer`, `diff`, `viewer` and apps `web`, `worker`.
- **Consequences:** analysis never runs inside Next.js, only in `apps/worker`.

## ADR-0013: Postgres + Drizzle for metadata, R2 for snapshots
- **Context:** graph snapshots can be tens of MB; metadata is small and relational (D5.5, D5.7).
- **Decision:**
  - Postgres (Neon) via Drizzle ORM for users, repos, analyses, jobs, PR records, and the access-check cache.
  - Gzipped `architecture.json` snapshots in Cloudflare R2, keyed `public/<owner>/<repo>/<sha>.json.gz` or `private/<installationId>/<repoId>/<sha>.json.gz`.
- **Consequences:** our own repo doesn't use Prisma, so the Prisma detector is exercised through fixtures and eval repos.

## ADR-0014: BullMQ + Redis job queue
- **Context:** analysis takes up to 5 minutes and must run on the isolated worker, not in a web request. We need queuing, retries, stalled-job recovery, concurrency caps, dedupe, and progress (D5.6).
- **Options:**
  - pg-boss on Postgres.
  - BullMQ + Redis.
- **Decision:** BullMQ on Redis, co-located with the worker on the Oracle VM.
  - Redis listens only on the Docker network.
  - Job ID is `<owner>/<repo>@<sha>` (dedupe).
  - `attempts: 3` with exponential backoff; concurrency 2.
- **Consequences:**
  - The web app enqueues through a small authenticated enqueue endpoint on the worker host (Redis is never exposed publicly).
  - Abhinav learns BullMQ.

## ADR-0015: $0 hosting
- **Context:** the budget is $0 (D8.1, D8.2).
- **Decision:**
  - Vercel Hobby (web).
  - Oracle Cloud Always Free ARM VM (worker + Redis in Docker).
  - Neon free (Postgres).
  - Cloudflare R2 free (snapshots).
  - Domain `gitinside.abhinavgonthina.dev`.
  - VM provisioning is fully scripted.
- **Consequences:**
  - Never generate artificial load to avoid Oracle's idle reclamation.
  - Snapshot retention must fit 10 GB (R2) and metadata must fit 1 GB (Neon).
  - Fallback is Cloud Run Jobs + pg-boss, which needs a new ADR.
  - Nothing may be purchased or upgraded automatically.

## ADR-0016: Milestone order puts evaluation early
- **Context:** accuracy problems found late are expensive (D4.1).
- **Decision:** M1 analyzer → M2 cross-service → M3 eval → M4a design system (approval gate) → M4b explorer → M5 website → M6 diff + incremental → M7 backtest → M8 sign-in + App → M9 launch-ready.
- **Consequences:** every analyzer change after M3 reruns the eval and reports deltas.

## ADR-0017: Design gate after M4a
- **Context:** great UI is a pillar and taste is Abhinav's (D4.4, D6.1).
- **Decision:** after M4a, autopilot opens a `needs-abhinav` issue with light and dark screenshots and stops UI work until he approves in the issue. Non-UI tasks continue.
- **Consequences:** M4b can't start before approval. Feedback lands in `docs/DESIGN_SYSTEM.md` before UI work resumes.

## ADR-0018: Windows-only autopilot script
- **Context:** both of Abhinav's machines run Windows. KICKOFF §7A asked for `autopilot.sh` too. The loop scripts are deny-protected, so any new script must be installed by Abhinav by hand.
- **Decision:** maintain only `scripts/autopilot.ps1`. Add `autopilot.sh` later if a Mac or Linux machine is used.
- **Consequences:** one script to keep correct, and less manual copying for Abhinav.

## ADR-0019: Stable node identity from qualified names
- **Context:** diffs need the same node to have the same ID across commits.
- **Decision:** node ID = `<kind>:<service>/<qualified path>`. For example:
  - `symbol:api/src/routes/orders.ts#createOrder`
  - `route:api/POST /api/orders`
  - `model:api/Order`

  File moves and renames are detected in the diff by content similarity and reported as `renamed`, not as remove + add.
- **Consequences:** IDs are human-readable and deterministic. Renames need a similarity threshold, tuned against fixtures in M6.

## ADR-0020: Inventory skips with warnings; only the file limit is fatal
- **Context:** the inventory (M1.3) decides which files the pipeline may read. "Fail visibly" says nothing may disappear silently, but one odd file shouldn't fail a whole analysis.
- **Decision** (`packages/analyzer/src/inventory.ts`):
  - A fixed list of directory names (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `vendor`, …) is skipped at any depth with no warning, because skipping them is expected.
  - Everything else that gets skipped produces a graph warning: symlinks are never followed (`SKIPPED_SYMLINK`), files over 2 MB (`SKIPPED_LARGE`), directories deeper than 64 levels (`SKIPPED_DEPTH`), and generated files, meaning `*.min.js` or an `@generated` / "DO NOT EDIT" marker in a source file's first 1 KB (`SKIPPED_GENERATED`).
  - More than 20,000 kept source files throws `AnalysisError` `LIMIT_FILES` with the exact count. Generated and oversized files don't count.
  - `.gitignore` is not read. GitHub tarballs only contain tracked files, so it only matters for local CLI runs.
- **Consequences:** results are deterministic and every skip can be explained in the UI. A local run may walk a gitignored folder that isn't on the list. A generated file with no marker is analyzed like hand-written code.

## ADR-0021: Services come from workspace folders, keyed by folder name
- **Context:** service keys appear in every node ID (ADR-0019), so they must be short, readable, unique, and stable across commits and machines (D2.3).
- **Decision** (`packages/analyzer/src/workspace.ts`):
  - Workspace packages are the union of root `package.json` `workspaces`, `pnpm-workspace.yaml`, and `lerna.json` patterns (Lerna's default `packages/*` if none are listed), plus every `project.json` folder when `nx.json` exists. `turbo.json` only marks the tool. Globs use a small built-in matcher, not a dependency.
  - The service key is the **folder name** (`apps/api` → `api`), not the package name, so renaming a package doesn't change every ID. Colliding names and the reserved pseudo-services `infra`/`ext` fall back to the directory with `/` → `-` (`apps-web`), then a numeric suffix, assigned in sorted order.
  - With no workspace packages, the repo is one root service keyed by its unscoped package name, or `app`. The repo's directory name is never used, because it differs between machines.
  - In a workspace repo the root package is not a service. Files outside every package belong to no service (M1.6 decides how to show them).
  - `framework` comes from `dependencies`/`peerDependencies`/`optionalDependencies` (`next` > `express` > `react`), and cycle warnings use the same runtime fields. Dev dependencies are ignored for both.
  - Invalid config, patterns matching nothing, duplicate package names, and dependency cycles are warnings, never errors.
- **Consequences:** IDs survive package renames but change when a folder moves (the diff's rename detection handles that, M6). `pnpm-workspace.yaml` is parsed with the `yaml` package, which M2.7 needs for docker-compose anyway.

## ADR-0022: One TS program per service over an inventory-only compiler host
- **Context:** cross-file resolution (imports, `paths` aliases) needs a `ts.Program` per service (D5.1), but the repo is untrusted (T1), has no `node_modules`, and may have broken or partial tsconfigs.
- **Decision** (`packages/analyzer/src/program.ts`):
  - A custom `CompilerHost` answers `fileExists`/`readFile`/`directoryExists` from the inventory only, plus TypeScript's own bundled `lib.*.d.ts`. Skipped, symlinked, and `node_modules` files are invisible, so package imports stay unresolved until M1.8 maps workspace packages.
  - Root files are every TS/JS source file the service owns (`serviceForFile`), not the tsconfig's `include`, so tests and scripts are analyzed and the graph doesn't depend on build config. The tsconfig only supplies compiler options.
  - Config lookup: `tsconfig.json`, then `jsconfig.json`, in the service folder; `extends` chains work within the repo. Missing config → `TSCONFIG_MISSING`; unparseable config or errors such as an npm-package `extends` → `TSCONFIG_INVALID`. Neither is fatal.
  - Unset options are filled from synthesized defaults (ES2022, ESNext + Bundler resolution, `jsx: preserve`); a `module` set without `moduleResolution` gets Bundler (ES kinds) or Node10, never Classic. `allowJs`, `noEmit`, `skipLibCheck`, `types: []`, and no composite/incremental/declaration always win.
  - Syntax errors become one `SYNTAX_ERROR` warning per file (first error's line:column plus a count); TS's error recovery still yields an AST. Diagnostic text has the absolute repo root stripped so warnings are identical on every machine.
  - Parsed lib files are cached per process; they come from our install and never change.
- **Consequences:** analysis never touches anything outside the repo except TS's libs. Project `references` and `include`/`exclude` are ignored, so a solution-style tsconfig contributes only its own options. Lib parsing costs ~0.5 s once per process.

## ADR-0023: Symbols are top-level declarations; exports are detected syntactically
- **Context:** symbol nodes (M1.7) are the leaves that `calls`, `handles`, and `renders` edges attach to, so they must include every function a route or page could point at, without flooding the graph with every local constant.
- **Decision** (`packages/analyzer/src/symbols.ts`):
  - Only top-level statements are read. Functions (skipping overload signatures), classes, and function- or arrow-valued `const`/`let`/`var` are always symbols. Any other variable is a symbol only when exported.
  - Methods are class methods with a body (or `abstract`) plus function-valued class properties (`handle = () => {}`). Their ID is `Class.method`, their parent is the class symbol, and they inherit the class's `exported` flag. Constructors and get/set accessors are skipped.
  - Exports are read from syntax, not the type checker: the `export` modifier, local `export { … }` lists, `export default` / `export =`, and the CommonJS forms `module.exports = x | { … }`, `exports.x = …`, `module.exports.x = …`. Exporting an identifier marks the local declaration. An inline exported value becomes a symbol under its export name, or `default` when it has none.
  - Ambient (`declare`) declarations and `.d.ts` files yield no symbols. On a name collision within a file, the first declaration wins.
  - `source` spans the declaration, starting after any JSDoc.
- **Consequences:** the result depends only on the file's own text, so it is cheap to cache per content hash (M6.7) and easy to explain. Express controllers written as `module.exports = { list: async (req, res) => … }` get named symbols for M1.10. Nested functions, `exports["x"]`, and `Object.assign(module.exports, …)` produce no symbols. Calls made inside them are attributed to the enclosing top-level symbol in M1.9.

## ADR-0024: Import edges via TS resolution, workspace manifests, and visible failures
- **Context:** `imports` edges (M1.8) are the first edges in the graph and the base for broken-connection detection (ADR-0006). There is no `node_modules`, so TypeScript alone can't resolve `@acme/shared` in a monorepo, and "fail visibly" rules out silently dropping imports that should resolve.
- **Decision** (`packages/analyzer/src/imports.ts`):
  - Specifiers come from import/export-from declarations (type-only included, since they are real file dependencies), `import x = require()`, and literal `require("x")` / `import("x")` calls anywhere in the file. Asset specifiers (`.css`, `.svg`, `.json`, …) are ignored.
  - TypeScript's `resolveModuleName` runs first, with the service's compiler options over the inventory-only host. A hit is `exact`.
  - A bare specifier naming a workspace package (longest name wins) is resolved from that package's `package.json`: `exports` (string, conditions, or exact subpath key), then `source`/`types`/`typings`/`module`/`main`, then the subpath itself, each `exact`. If those all point at missing files (usually a skipped `dist/`), `src/index` or `src/<subpath>` and then `index` are `heuristic`. `index` is `exact` when the manifest names no entry, because that's Node's default.
  - A specifier that must be local (relative, absolute, `@/`, `~/`, `#`, a non-`*` `paths` key, or a workspace package) but doesn't resolve becomes an `unresolved` node with reason `UNKNOWN_SYMBOL`, parented to the importing service, ID `unresolved:<service>/<file>:<line>:<column>`. Other bare specifiers are third-party packages and get no edge yet (M2.6 handles SDKs).
  - A target in the repo but outside every service is an `IMPORT_OUTSIDE_SERVICE` warning, not an edge.
- **Consequences:** imports of skipped files (generated, oversized) show up as unresolved, which is honest. `exports` wildcards (`./*`) and `typesVersions` aren't followed. `UNKNOWN_SYMBOL` is reused rather than adding a schema reason, so the schema stays at 1.0.0. Unresolved IDs carry the column, so two imports on one line can't collide.

## ADR-0025: Call edges via the type checker, with workspace imports bridged by hand
- **Context:** `calls` edges (M1.9) feed trace mode and broken-connection detection, so they must point at real declarations. TypeScript's checker resolves calls precisely within a program, but there is no `node_modules`, so it can't follow `import { f } from "@acme/shared"` into another workspace package, which is exactly where architecture lives in a monorepo.
- **Decision** (`packages/analyzer/src/calls.ts`):
  - The caller is the innermost extracted symbol (ADR-0023) whose declaration contains the call. Calls in nested functions and callbacks belong to the enclosing top-level symbol. Top-level calls have no caller and produce no edge.
  - The callee name (`f`, the `m` of `a.m`, `a["m"]`, or the class of `new C()`) is resolved with `getSymbolAtLocation`, following aliases, re-exports, `{ list }` / `{ list: impl }` properties, and `const a = b`, up to 8 hops. A declaration maps to a symbol node by repo path, node kind, and text span, so a file loaded into another service's program still matches.
  - When an alias points at a module TypeScript couldn't resolve, the import is resolved with the M1.8 resolver (now shared as `createModuleResolver`) and the name is looked up among the target module's exports with the target service's checker, so re-export chains work. The edge takes the import's confidence (`heuristic` for `src/index` fallbacks); everything else is `exact`.
  - Unresolved callees produce no edge or `unresolved` node: third-party and built-in calls are the overwhelming majority, and showing them would bury the diagram. Local imports that fail are already visible as unresolved `imports` edges. Recursion (self-edges) is skipped.
- **Consequences:** precision is high because nothing is guessed. Recall misses untyped values (methods on instances of classes from another workspace package, parameters called as callbacks), computed element access, and `require` of workspace packages. Call sites record the callee name's position.

## ADR-0026: Express routes from tracked router objects, composed over a mount graph
- **Context:** route nodes (M1.10) are what M2's matcher links frontend calls to, so their full paths must be right. Express builds paths at runtime (`app.use("/api", r)` + `r.get("/users/:id")`), routers travel across files and through functions, and there are no `express` types (no `node_modules`), so the checker can't tell an Express `get` from `Map.get`.
- **Decision** (`packages/analyzer/src/express.ts`):
  - **Router objects** are found syntactically: calls to `express()`, `express.Router()`, or `Router()` where the name is bound to `express` by a top-level import or `require`, plus parameters typed `Express`/`Application`/`Router` from `express`. Only calls on an expression that resolves to one of these count as routes or mounts. Resolution uses the checker to follow variables, imports, `export default`, CommonJS `module.exports`/`require`, object properties, class properties, chained calls (`router.get()` returns the router), and factory functions that return a router.
  - **Parameter binding:** a call `f(app)` where `app` resolves to a router makes `f`'s parameter an alias of it (a mount at `""`), repeated until no new parameter appears (at most 8 rounds). This covers `module.exports = (app) => { app.get(…) }` without types.
  - **Composition:** mounts form a graph; a depth-first walk from every unmounted app or router joins prefixes (one `/` between segments, no trailing `/`). A router mounted twice yields its routes twice. Cycles are cut; routers mounted only inside a cycle are walked from the first one seen.
  - **IDs:** `route:<service>/<METHOD> <path>`, where the service is the root app's (the deployment that serves it), and the parent is the file that registers the route. Duplicate registrations merge; the earliest source wins.
  - **Failures stay visible:** a non-static route path or mount prefix makes each affected route an `unresolved` node (`DYNAMIC_ROUTE`, expression like `GET process.env.PREFIX + /users`), parented to the service, with no edge. A router never mounted on an app gets an `EXPRESS_UNMOUNTED_ROUTER` warning and keeps router-relative paths.
  - **Handlers:** every handler argument (including middleware and arrays) that resolves to a symbol node via the M1.9 resolver (now `createSymbolResolver`, shared) gets a `handles` edge.
- **Consequences:** routes are only found on objects provably created by Express, so precision is high; a local `http.get(path, cb)` never becomes a route. Inline arrow handlers and wrapped handlers (`asyncHandler(fn)`) get no `handles` edge, which breaks the route → logic chain for those apps; M2 may revisit. Routers imported from other workspace packages, routers in collections or loops, and constructor-assigned properties without initializers are missed, which shows up as an `EXPRESS_UNMOUNTED_ROUTER` warning when the router side is visible.

## ADR-0027: Next.js routes and pages from the file system, exports from the checker
- **Context:** Next.js apps (M1.11) declare routes by where files sit, not by calls, so paths are always static. What varies is how a route file exports its handlers (`export function GET`, `export const { GET, POST } = handlers`, `export { h as GET }`, re-exports), which router folder is live, and what the pages router's API handlers accept.
- **Decision** (`packages/analyzer/src/next.ts`):
  - Only services that declare `next` as a dependency are scanned, so an unrelated `pages/` folder never becomes routes. Router folders are `app/` and `pages/`, or `src/app/` and `src/pages/` when neither root folder holds a source file (Next's rule). Only the default page extensions count; `next.config` is never read.
  - **Paths:** `[id]` ⇒ `:id`, `[...x]` and `[[...x]]` ⇒ `*x`, `(group)` and `@slot` dropped, `index` maps to its folder. App router `_private` folders and intercepting routes (`(.)x`, `(..)x`, `(...)x`) produce nothing.
  - **Route handlers:** the method names come from `checker.getExportsOfModule`, so every export form (including re-exports and `export *` from local files) counts. Each exported method becomes `route:<service>/<METHOD> <path>` with a `handles` edge to the symbol the export resolves to (the shared resolver, ADR-0025). A `route.ts` with no method export gets a `NEXT_ROUTE_NO_METHODS` warning rather than vanishing.
  - **Pages router API:** method `ALL`, unless the default-export function compares its request's `method` with string literals (`===`, `!==`, `switch`, `[...].includes`, also through `const { method } = req`); then one route per method named. A `!==` guard counts, because `if (req.method !== "POST") return 405` means the route is POST.
  - **Pages:** `page:<service>/<path>` (frontend layer) with a `renders` edge to the default export.
  - **Collisions:** two files mapping to one ID keep the first by path with a `NEXT_DUPLICATE_ROUTE` warning. When a custom Express server registers the same route, the Express node wins and both `handles` edges are kept.
- **Consequences:** no `unresolved` nodes are needed, since file-system paths are always static. `basePath`, `pageExtensions`, `i18n`, rewrites, and middleware are invisible until v1.1; a repo using `basePath` gets wrong paths with no warning, which M3's eval should catch. Optional catch-alls lose the "also matches the parent" detail. Wrapped API handlers (`export default withAuth(h)`) stay `ALL`.

## ADR-0028: Prisma models from a line parser, client usage traced to `new PrismaClient()`
- **Context:** Prisma (M1.12) is the data layer of v1. The schema is its own language, and the client's types are generated into `node_modules`, which we never have. So the checker can't tell `prisma.user.findMany()` from any other `a.b.c()` call by type, and Prisma's own parser ships as an engine binary or WASM, which we won't load to read untrusted input.
- **Decision** (`packages/analyzer/src/prisma.ts`):
  - **Schema:** a small line-based parser reads `model`, `view`, and `datasource` blocks from every `.prisma` file (so multi-file schemas work), ignoring `//` comments outside strings. Unreadable lines become a `PRISMA_SYNTAX` warning; the rest of the file is still used. Models are `model:<service>/<Name>`, parented to their schema file, so they sit with the other code of their folder when drilling down.
  - **Datastores:** a literal `provider` becomes `datastore:infra/<service>/<schema file>#<datasource>` with a normalized engine (`postgresql` ⇒ `postgres`), plus `stores` edges from that file's models (or the whole service's when its multi-file schema has one datasource). The ID includes the service and file, because two services both on Postgres may well be two databases; merging them would be a guess. M2.7 links these to compose services.
  - **Client tracing:** a receiver is a client when the checker follows it (variables, imports including workspace packages via a new `importTarget` hook on the shared resolver, default and CommonJS exports, class properties, `??`, ternaries, `$extends`, factories) to `new PrismaClient()`, a class extending it, or a declaration typed `PrismaClient`/`TransactionClient`; `$transaction` callback parameters count too. These edges are `exact`. An untraced receiver named `db`, `database`, `client`, `tx`, `trx`, or `*prisma*` whose accessor and op both match counts as `heuristic`, because tRPC-style `ctx.db` is common and untyped without `node_modules`.
  - **Model lookup:** the schema of the service that created the client, then the calling service's, then the only service that has the model. Several candidates make an `AMBIGUOUS` unresolved node; a traced client naming no known model makes `UNKNOWN_SYMBOL`. Raw queries (`$queryRaw`, `$executeRaw`, …) make `RAW_QUERY` unresolved nodes. All three keep `reads`/`writes` edges to the unresolved node, so nothing is dropped.
  - **Edge source:** the innermost symbol, or the Express route when the call is in an inline handler. The Express detector now returns `inlineHandlers` (handler function ⇒ route IDs, one wrapper call deep) for this.
  - **Field-level usage:** `GraphEdge` gains an optional `fields: string[]`, the model fields named in top-level `select`/`include`/`where`/`data`/… keys, filtered to real field names and sorted. The schema stays at 1.0.0: the key is optional and additive, and no graph has been published yet.
- **Consequences:** precision stays high because the exact tier requires a provable client. Recall misses delegates in variables, destructured clients with unusual names, generic repository wrappers, and nested writes (`data: { posts: { create } }` lists `posts` on the parent but draws no edge to `Post`). `@@map` table names are ignored. The heuristic tier is a measured risk: M3's eval reports it separately by confidence.

## ADR-0029: One assembly step merges pass outputs; writes validate the serialized text
- **Context:** by M1.12, `analyze()` concatenated each pass's nodes and edges by hand and filtered Next.js items that Express already produced. Every new detector (M2's HTTP, compose, queues, SDKs) can emit an ID another pass also emits, and each would need its own ad hoc filter. A collision would then either crash `parseGraph` with a raw Zod error or be silently dropped.
- **Decision** (`packages/analyzer/src/assemble.ts`):
  - `assembleGraph` takes the passes as ordered `GraphPart`s; the order is the precedence. The first node per ID wins. A later node with the same ID but different content is dropped with a `DUPLICATE_NODE` warning naming both passes (fail visibly); an identical one merges silently.
  - Edges with one ID merge: sites and `fields` are unioned, and the strongest confidence is kept (exact > pattern > heuristic), since a pass that proved the edge outranks one that guessed it. `unresolved` can't compete, because it's fixed by the target node.
  - Exact duplicate warnings are removed. The in-memory graph keeps pipeline order; `stringifyGraph` alone applies the canonical order on write.
  - A schema failure becomes `AnalysisError` `INVALID_GRAPH` listing the first 5 issues with their paths. It always means an analyzer bug.
  - `serializeGraph` runs `stringifyGraph`, parses the text back, and validates it, catching values JSON can't carry (`NaN` ⇒ `null`). The CLI writes `--out` through a temp file and a rename, so a failed run never truncates an existing graph.
- **Consequences:** detectors stay independent; precedence lives in one list in `analyze()`. Validating twice costs a few milliseconds per graph, negligible next to parsing.
