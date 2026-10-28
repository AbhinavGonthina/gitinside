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
  - Gzipped `architecture.json` snapshots in Cloudflare R2, keyed `public/<owner>/<repo>/<sha>.json.gz` or `private/<installationId>/<repoId>/<sha>.json.gz`. **Amended by ADR-0062:** keys end `<sha>/<analyzerVersion>.json.gz`, one object per `analyses` row.
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
  - Everything else that gets skipped produces a graph warning: symlinks are never followed (`SKIPPED_SYMLINK`), files over 2 MB (`SKIPPED_LARGE`), directories deeper than 64 levels (`SKIPPED_DEPTH`), and generated files, meaning `*.min.js`, or in a source file's first 1 KB an `@generated` marker or "generated" and "do not edit" on one line (`SKIPPED_GENERATED`). "Do not edit" alone was dropped after the M1 review, because hand-written comments use it too.
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
  - **Pages router API:** method `ALL`, unless the default-export function compares its request's `method` with string literals (`===`, `!==`, `switch`, `[...].includes`, also through `const { method } = req`); then one route per method named. A `!==` guard counts, because `if (req.method !== "POST") return 405` means the route is POST. When other methods may still fall through to real code (no negative guard, `switch` `default`, `405`, or `Allow` header, and the checks aren't in the handler's last statement without a final `else`), `ALL` is emitted too, so the fall-through in `if (GET) return list(); return create();` stays visible as `ALL` (revised after the M1 fresh-eyes review). Type-only exports (`export type GET`) are not routes.
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

## ADR-0030: HTTP call sites are collected as records with "unknown" kept distinct from "absent"
- **Context:** M2's resolver is split into collect (M2.1), normalize (M2.2), wrappers (M2.3), match (M2.4), and unresolved output (M2.5). The ROADMAP requires that no collected call site is silently dropped. Without `node_modules`, axios is an unresolvable import, so the checker can't type `api.get()`; and request configs are often built at runtime.
- **Decision** (`packages/analyzer/src/http.ts`):
  - `collectHttpCalls` returns sorted `HttpCallSite` records (client, program, call, site, owners, method, URL, base URL, confidence) and emits no graph output yet. Later stages consume the records.
  - **`null` means "set, but not statically readable"; `undefined` means "not set".** A `fetch` without `init.method` is `GET`; one whose `init` is an unknown variable or contains a spread before `method` has method `null`. A config property after the last spread is read; one that a spread could supply is `null`. M2.5 turns every `null` into an unresolved edge with a reason rather than a guess.
  - **axios is recognized from its import, not its types:** the default or namespace import of `"axios"`, `require("axios")` (in JS files TypeScript models it as an alias, so the alias's own declaration is checked before following it), and instances from `.create(config)` traced like the Prisma client (variables, imports incl. workspace packages, exports, operators, factories, object properties). A declaration typed `AxiosInstance` is an instance with an unknown base URL.
  - **`axios(x)`** is the URL form only when `x` is string syntax or string-typed; otherwise it's the config form, so an untyped `x` gives an unknown URL and method instead of treating a config object as a URL.
  - **Shorthand calls** (`api.get(url, cfg)`) with an unreadable `cfg` keep the instance's base URL: overriding `baseURL` per call is rare, and marking every such call unknown would hide the common case. This is listed under "not handled".
  - Only the global `fetch` (or one from `node-fetch`, `undici`, …) counts. A repo function named `fetch` is a wrapper, left to M2.3.
  - Axios results are memoized per checker symbol (in-progress symbols map to `null`, which also stops cycles). On cal.com the pass collects 217 sites in 2.7 s after the `calls` pass has warmed the checkers.
- **Consequences:** M2.2 receives expressions together with the program whose checker understands them, so a base URL defined in another workspace package resolves its imported consts in that package. Recall misses other clients (`ky`, `got`, `ofetch`), destructured instance methods, instances assigned in constructors without a type, and `defaults.baseURL` mutations.

## ADR-0031: URLs normalize in two layers, parts then pattern, and a leading hole is `DYNAMIC_URL`
- **Context:** M2.2 turns each call site's URL and `baseURL` expressions into something the route matcher (M2.4) can align with route paths. The same evaluation must later run with wrapper parameters bound (M2.3), and ROADMAP M2 asks for a property test of normalizer idempotence.
- **Decision** (`packages/analyzer/src/url.ts`, shared tracing in `values.ts`):
  - **Two layers.** `parts()` evaluates an expression to a flat list of `text`, `hole`, `env`, and `origin` parts using the checker (consts through imports and workspace packages, const objects incl. nested ones, string enums, single-literal types, env reads, `location.origin`, `new URL`). `toUrlPattern()` is pure: it reads the parts as a base (`path`, `page`, literal `host`, or `env`) plus segments of text and holes. The pure layer is what the fast-check properties test; `patternParts()` is its inverse, so idempotence is `toUrlPattern(patternParts(p)) = p`.
  - **A URL starting with a hole is `DYNAMIC_URL`,** and so is a non-host URL whose segments are all holes, or a host with a hole before the port. There is nothing to match such a URL on, and treating `${base}/users` as `/users` would be a guess. The result carries a fixed English `detail` for the UI.
  - **Env vars are bases only at the start.** `env ?? "http://localhost"` and `env || …` read as the env var, since the env var is the deployed value; the matcher (M2.4) decides from the name whether it means "same deployment" (heuristic).
  - **axios joining copies axios** (`combineURLs`/`isAbsoluteURL`): an absolute URL ignores `baseURL`, an empty base is no base, otherwise one `/` joins them. **`new URL(u, base)`** uses Node's WHATWG parser only when both are literals; a root-relative `u` keeps the base's origin (literal, env, or page origin); anything else is a hole, because the base's path is unknown.
  - **Query strings and fragments** are cut at the first literal `?`/`#`; empty segments are dropped; scheme and host are lowercased, the path isn't.
  - **Confidence:** a resolved URL is `exact` unless a value came through a heuristic workspace import, in which case it takes that import's confidence.
  - `constString`, `constObject`, `objectProperty`, and `resolveDeclaration` moved from `http.ts` into `values.ts` so the collector and the normalizer read values the same way. `http.ts` behavior is unchanged (its tests pass untouched).
- **Consequences:** a wrapper body like `fetch(BASE + path)` normalizes to `/api{}` today; M2.3 will bind `path` to the caller's argument and re-run `parts()`. On cal.com 130 of 217 sites resolve (41 root-relative, 74 literal host, 15 env base) and 87 are `DYNAMIC_URL` (82 start with a runtime value, 4 have a runtime host, 1 has an unreadable URL), almost all URLs held in variables or parameters or built by function calls (e.g. `WEBAPP_URL = ensureProtocol(process.env.…) || …`). Normalizing all 217 takes 69 ms.

## ADR-0032: Wrappers inline one level by re-normalizing with bound parameters; each wrapper call is its own request
- **Context:** M2.3. Real clients route requests through helpers (`fetcher(endpoint, init)`, `api.get(path)`), so the `fetch` inside the helper reads a parameter and is `DYNAMIC_URL` or `/api{}` on its own, and its method is often hidden behind `{ method: "GET", ...init }`. The URL that matters is at each call to the helper. DESIGN.md §7.1 asks for one level of inlining and `WRAPPER_DEPTH` beyond.
- **Decision** (`packages/analyzer/src/wrappers.ts`, plus small hooks in `url.ts` and `http.ts`):
  - **A wrapper is a symbol (M1.7) whose function directly contains a call site that reads one of its parameters** in the URL, `baseURL`, or method. Nested closures and functions that aren't symbols are not wrappers: their sites stay as they are.
  - **Callers are found with the shared symbol resolver** (M1.9), so imports, renamed and default imports, namespaces, class instances, and workspace packages work the same as call edges. Only calls spelled like a wrapper's name or made through an import alias are resolved, to keep the scan cheap.
  - **Inlining re-runs the M2.2 normalizer with bindings** (parameter declaration ⇒ caller argument, else the parameter's default). The argument is evaluated in the caller's scope with the bindings switched off, so recursion terminates. Unbound parameters are holes marked `param`.
  - **`WRAPPER_DEPTH`:** while inlining, a URL or `baseURL` that still starts with a `param` hole came from the caller's own parameter, so only a second level could resolve it. A `param` hole later in the URL (`get(\`/users/${id}\`)`) is an ordinary hole.
  - **Each wrapper call becomes its own `HttpRequest`**, located at and owned by the caller, with `via` pointing at the wrapper call and `call` at the inner site. The inner site yields no request of its own when it has callers; a wrapper with no visible callers keeps its own request. So every collected site is represented at least once (ROADMAP's "no call site dropped").
  - **Methods:** `HttpCallSite.methodSource` records where an unreadable method came from (a `method` value, an unlocatable config, or the spreads in a config literal with the `method` before them). Inlining reads it with the bindings: the last spread that sets `method` wins, and a missing argument spreads nothing, so `fetcher("/rooms")` is `GET` and `fetcher("/rooms", { method: "POST" })` is `POST`.
  - **Confidence** is the weakest of the call site's, the URL's, and the wrapper call's resolution.
- **Consequences:** on cal.com, 27 of 217 sites are wrapper bodies; inlining turns them into 79 requests (269 in total, 0 sites dropped). Resolved requests rise from 130 to 157, and inlined methods that were unknown now read `GET`/`POST`/`PATCH`/`DELETE`. Inlining takes 1.3 s, mostly resolving candidate calls. A forwarded parameter in the middle or at the end (`fetcher(endpoint, …)` ⇒ `https://api.daily.co/v1{}`) stays a hole rather than `WRAPPER_DEPTH`: telling a forwarded sub-path from a path parameter would be a guess, so the matcher (M2.4) sees the hole. Destructured parameters, `arguments`, reassigned parameters, URLs held entirely in a config parameter, and invisible (callback) callers are not handled; the file comment lists them.

## ADR-0033: Routes match on base, method, and path levels; ties break on path, then method; ambiguity floors at heuristic
- **Context:** M2.4. DESIGN.md §7.4 defines segment rules and three confidence levels, but leaves open how the base and method combine with the path, what happens to an unreadable method, what "downgrade one level" means for a heuristic match, and where an edge from top-level code starts.
- **Decision** (`packages/analyzer/src/match.ts`):
  - **Three independent levels, weakest wins.** Base: root-relative is `exact` within the caller's service and `heuristic` across services (it assumes a proxy or rewrite); page-relative is `heuristic`; an env var is `heuristic` only when named `API_URL`/`BASE_URL`/`*_API_URL`/`*_BASE_URL`; a loopback host is `heuristic` against every service; any other literal host is an external API and never a route. Method: equal, `ALL`, or `HEAD` → `GET` is `exact`; an unreadable method matches every method at `heuristic`. Path: the §7.4 segment rules, plus optional params (absent is `exact`) and partly literal segments (`user-{}`), which may spell a literal or fill a param at `pattern`. A pure hole never matches a literal. The result is then no stronger than the request's own confidence.
  - **Tie-breaks before ambiguity.** At the best overall level, the best path level wins: under an env base every match is `heuristic`, and without this `/api/users/me` would tie with `/api/users/:id`. Then a route with the request's method beats an `ALL` route (the pages router's fall-through `ALL` is the same handler). Remaining ties are real ambiguity. There's no further "more specific route" rule: Express picks by registration order, which isn't visible across files, so `/v1/acme/items` against `/v1/:org/items` and `/v1/:org/:kind` links both.
  - **Ambiguity downgrades one level but not below `heuristic`.** `unresolved` would require an `unresolved` target node (integrity rule 5), and the candidates are real routes. The edge records `reason: "AMBIGUOUS"`; when the same (owner, route) edge also has an unambiguous site, the strongest confidence wins and the reason is dropped.
  - **Path alignment is dynamic programming** over (call segment, route segment), so wildcards and optional params cost O(n·m), never backtracking. Partly literal segments use greedy leftmost glob matching, not a RegExp.
  - **Route index:** method, then first literal segment, with a catch-all bucket for routes starting with a param or wildcard. A call whose first segment is a pure hole only scans the catch-all bucket.
  - **Edge source:** each owner symbol or inline-handler route; top-level code uses its file node. A request in a file outside every service with no owner gets no edge yet (M2.5).
  - **Outcomes, not just edges.** `match()` returns `routes`, `external` (literal host), or `unresolved` (`DYNAMIC_URL`, `WRAPPER_DEPTH`, `NO_MATCHING_ROUTE` with a detail). M2.4 draws edges only for `routes`; M2.5 turns the rest into unresolved and external nodes.
  - `weaker()` in `values.ts` now ranks all four levels (it previously assumed only `exact`/`heuristic`, which was all its callers passed).
- **Consequences:** on cal.com, the `http` stage emits 38 edges from 41 sites (22 exact, 7 pattern, 9 heuristic, 0 ambiguous) in 3.8 s, almost all of it collection and inlining. Until M2.5, requests that match no route are absent from the graph. M3's eval should measure whether the cross-service `heuristic` for root-relative URLs and the env-name pattern are too strict or too loose.

## ADR-0034: Unmatched requests become unresolved nodes at the call site; literal hosts become external nodes
- **Context:** M2.5. After M2.4, requests that matched no route were dropped from the graph, which breaks "fail visibly" and ROADMAP M2's "no call site dropped". DESIGN.md §7.4 says what to create, but not which edge kind points at an external, where an inlined request's node sits, how hosts are keyed, or where the matcher's readable detail goes.
- **Decision** (`buildHttpEdges` in `packages/analyzer/src/match.ts`):
  - **Unresolved:** one `unresolved` node per request site (`unresolved:<service>/<file>:<line>:<column>`, under the service), at the wrapper call when inlined, since that is where a reader can act. `reason` is the matcher's (`DYNAMIC_URL`, `WRAPPER_DEPTH`, `NO_MATCHING_ROUTE`); `expression` is the call's source text (whitespace collapsed, cut at 120 characters, the helper now shared with Prisma in `values.ts`); `label` is `METHOD url` when the URL was read, else `METHOD <url source>`. Each owner (or the file node, for top-level code) gets an `http` edge to it at `unresolved`. Several requests at one site share its node; the first request's reason wins.
  - **New optional `detail` field on `unresolved` nodes** (schema): the matcher's sentence ("the URL starts with a value only known at runtime"). The reason code alone doesn't tell a user what to fix. It's additive and optional; `SCHEMA_VERSION` stays `1.0.0` because no graph has been published or consumed yet.
  - **External:** a literal non-loopback host becomes `external:ext/<host>` under the system (layer `external`), with an `external_call` edge (not `http`, which GRAPH_SCHEMA reserves for routes and unresolved targets). Confidence is `exact`, or the request's own weaker confidence (a workspace-imported axios instance). Hosts are lowercased (M2.2), credentials (`user:pass@`) are dropped in `toUrlPattern` so they never reach the graph, and a scheme's default port is dropped so `:443` doesn't split a node. No edge label: one edge merges many endpoints of one host.
  - **Edge merging:** an edge keeps a `reason` only when every merged site gave it (this generalizes M2.4's `AMBIGUOUS` rule).
  - `EXTERNAL_HOST` stays in the reason enum but is unused: a literal external host is a resolved `external` node, not an unresolved one.
- **Consequences:** on cal.com all 269 requests reach the graph: 38 route edges (unchanged), 135 unresolved nodes (112 `DYNAMIC_URL`, 23 `NO_MATCHING_ROUTE`, every one with an edge), and 79 `external_call` edges to 26 external hosts. Most `DYNAMIC_URL`s are `${WEBAPP_URL}/…` where `WEBAPP_URL` is a function result. 16 `NO_MATCHING_ROUTE`s target cal.com's v2 API (15 under `NEXT_PUBLIC_CALCOM_API_URL`, plus `/api/v2/slots/available`), whose NestJS routes v1 doesn't detect. Every request now reaches the graph (a request with no owner and no file node keeps its unresolved node with no edge, which can't happen for files inside a service). M2.6 adds SDK calls to the same `external` nodes, so its IDs and labels must use `externalHost()`.

## ADR-0035: SDK calls are traced to allowlisted client packages and keyed by the API's host
- **Context:** M2.6. ROADMAP lists an allowlist (stripe, `@aws-sdk/*`, resend, openai, twilio, `@sendgrid/*`, …) but not what counts as a call, which host an SDK maps to, or how an SDK node relates to the `external` nodes `fetch` calls already create (ADR-0034). Without `node_modules`, the checker knows nothing about an SDK's types, so `stripe.customers.create` has no symbol.
- **Decision** (`packages/analyzer/src/sdk.ts`, new `sdk` stage after `http`):
  - **One node per API host, shared with `fetch`.** Each package maps to its documented default endpoint (`stripe` ⇒ `api.stripe.com`), and nodes come from `externalNode()` in `match.ts`, so an SDK call and a literal-host `fetch` to one API produce byte-identical nodes that assembly merges silently, and edges from one symbol merge into one `external_call` edge. Edges are unlabeled, like `fetch` ones: a label would show or vanish depending on which pass produced the edge first.
  - **Families:** every `@aws-sdk/client-<name>` is accepted; listed clients use their real endpoint prefix (`ses` ⇒ `email.amazonaws.com`) at `exact`, others use `<name>.amazonaws.com` at `heuristic`, since that host is inferred from a package name. Every `@googleapis/<api>` maps to `www.googleapis.com`.
  - **Values are traced like axios instances** (ADR-0030): imports, `require`, variables, exports, workspace packages (at the import's confidence), and factories, including factories exported from workspace packages. An SDK value records its export path (`default`, `*`, `S3Client`, `calendar_v3.Calendar`) until it becomes a client, so `new X()` only counts when `X` is a client export: the default, a listed class, a `*Client` name, or a package pattern.
  - **A request is a method call on an SDK module value or client**, matched by the shortest SDK prefix of the callee. Calls on results aren't followed (one site per chain), calls that build a client (`google.calendar({ auth })`) aren't requests, and each package lists methods that run locally (Stripe `webhooks`, SendGrid `setApiKey`, AWS `destroy`).
  - **Types count only for client names**, so `out: GetObjectCommandOutput` is data, not a client, and `c: Stripe` is.
- **Consequences:** precision over recall: destructured clients, untyped `this.x = new Stripe()`, and directly called named exports are missed and listed under "not handled". Local helpers outside the `local` lists still draw an edge; this over-reports a dependency the code really has, never invents one. SDKs whose host is per-account (Supabase, Algolia, Salesforce), SMTP, and telemetry are off the list, so they get no edge, as with any third-party package (ADR-0024).

## ADR-0036: Compose services are the datastores; env URLs only link to them, and their values never leave the parser
- **Context:** M2.7. ADR-0028 gave each Prisma datasource its own datastore node and deferred the link to compose. ADR-0005 says the top level shows one node per datastore, so a Prisma `postgres` and a compose `postgres` that are the same database must not be two nodes. `.env` files hold real credentials, and SECURITY.md T5 allows reading key names and URL schemes/hosts only.
- **Decision** (`packages/analyzer/src/infra.ts`, new `infra` stage after `prisma`):
  - **Compose services with a known image are the nodes.** `datastore:infra/<dir>/<service>` (root: `datastore:infra/<service>`, as GRAPH_SCHEMA's example), or `queue:` for brokers, labeled with the service name. Files in one folder are one Compose project, so override files merge their host names and published ports into one node. Images match on the path without registry, `library/`, tag, or digest. Parsing uses `yaml` with merge keys on and at most 100 alias expansions; parse errors are reported by line with our own message, because yaml's can quote the file.
  - **Env files are parsed into keys and `{ scheme, host, port }` only.** Credentials, paths, and queries are dropped inside `parseEnv`; hosts are only compared against compose names, never written. Multi-line quoted values are skipped whole so their contents can't be read as keys.
  - **A Prisma datasource becomes a compose node** when its `url = env("KEY")` value (from env files in the schema's folder or above) names the service's host (`exact`), or a loopback host and a port the service publishes (`heuristic`). With no URL value at all, a lone compose service of that engine is linked (`heuristic`). Several candidates keep the Prisma node and warn `INFRA_AMBIGUOUS_DATASTORE`; a URL pointing elsewhere keeps it silently. `relinkStores` drops the linked Prisma node and retargets its `stores` edges, so the node count drops by one per link.
  - **Env-only datastores:** a URL key with an engine scheme that no datasource reads (`url`, `directUrl`, `shadowDatabaseUrl`) and no compose service serves becomes `datastore:infra/env#<KEY>`, labeled with the engine. The `#` keeps it apart from compose IDs, which can't contain one.
  - **`*_API_KEY` keys produce nothing.** A key is not a connection; SDK calls already draw the edge (ADR-0035). DESIGN.md's infra list is updated to match.
- **Consequences:** on cal.com, the 102 models of `packages/prisma` now store into `datastore:infra/packages/prisma/postgres` (`heuristic`: `.env.example` says `localhost:5450`, the compose file publishes `5450:5432`), and the separate Prisma datastore is gone. 6 compose datastores appear, including `postgres_is_ready`, a health-check container running the `postgres` image: an image says what a container runs, not whether it holds data. M3's eval should check whether skipping services with an overridden `command`/`entrypoint` is worth it. A literal Prisma `url`, `prisma.config.ts`, and compose `extends`/`include` are not handled.

## ADR-0037: Queues are identified by name; producers and workers meet at `queue:infra/redis#<name>`
- **Context:** M2.8. ROADMAP asks for BullMQ and known queue clients (`new Queue(name)`, `queue.add`, `new Worker(name)`) ⇒ `publishes`/`consumes`. A producer and its worker usually live in different services and hold different objects: what they share is the queue name (and a Redis server). GRAPH_SCHEMA already showed `queue:infra/redis#receipts`. A name built at runtime has no unresolved reason that fits (`DYNAMIC_URL` is about URLs).
- **Decision** (`packages/analyzer/src/queues.ts`, new `queues` stage after `sdk`):
  - **Libraries:** `bullmq` (`Queue`, `Worker`, `FlowProducer`), `bull`, `bee-queue`. All three are Redis-backed, so the engine is `redis` and the node is `queue:infra/redis#<name>`, labeled with the name, sourced at the first site that names it. The `#` keeps it apart from compose queue IDs. One name is one node whatever the library, `prefix`, or connection: telling those apart needs runtime config.
  - **Instances are traced like SDK clients** (ADR-0035), including workspace packages at the import's confidence and factory functions. A factory's parameters are bound to each call's arguments (or defaults), so `getQueue("email").add()` publishes to `email`.
  - **Edges:** `publishes` from the code that calls `add`/`addBulk`/`upsertJobScheduler` (Bull `add`/`addBulk`, Bee-Queue `createJob`), and each `queueName` in a BullMQ flow. `consumes` from the processor function's symbol when it resolves, else the code that creates the worker (`new Worker`, Bull/Bee `process`). Both are edges from code to the queue, as GRAPH_SCHEMA has them, so trace mode (M4b.6) must follow `consumes` edges in reverse to get from a queue to its workers.
  - **Worker factories.** When a `new Worker(name, …)` reads its name from its function's parameter, that function is a factory: a second walk traces only calls whose callee has the factory's name, binds them, and drops the factory's own unresolved edge once it has a call. Nested factories are found in later rounds. Tracing every call in the repo as a possible factory cost 2.8 s on cal.com with nothing to find; the name filter brings the stage to 0.8 s. The stage also skips repos where no source file quotes a library name.
  - **New unresolved reason `DYNAMIC_NAME`** (schema enum, additive, so `SCHEMA_VERSION` stays `1.0.0` as with `detail` in ADR-0034). The unresolved node sits at the name expression, or at the call when the queue came from a type annotation (`private queue: Queue`), with a detail saying which.
- **Consequences:** cal.com has no edges: its only queue code is NestJS `@Processor`/`@InjectQueue`, which v1 doesn't detect (no NestJS, like its routes in ADR-0034). Queue nodes aren't linked to a compose Redis node; there is no edge kind for "queue lives in datastore", and adding one belongs with the viewer work. Publishing wrappers (`enqueue(name, data)`), queues kept in maps, and renamed factory imports are listed under "not handled"; the last two show up as unresolved or missing, never as a wrong queue.

## ADR-0038: Unresolved requests show their source with string contents masked
- **Context:** M2.9's `fake-secrets` fixture found a leak. An unresolved HTTP node's `expression` (and, for wrapper calls, its label) was the whole call's source text, so `fetch(target, { headers: { Authorization: "Bearer …" } })` copied a hardcoded token into the graph, and a key in the query of a runtime URL (`` `${base}/items?api_key=…` ``) reached the label too. SECURITY.md T5 covers hardcoded keys, and graphs of public repos are served from a CDN.
- **Decision** (`redactedText()` in `packages/analyzer/src/values.ts`, used by `buildHttpEdges`):
  - **Text shown for an unresolved request keeps the code's shape but not its strings.** Every string and template literal's contents become `…`, except inside the URL: the `fetch`/axios URL and per-call `baseURL` expressions, or for an inlined wrapper call the arguments bound to parameters its URL reads (new `WrapperCall.url`). Inside the URL, literal text is kept up to and including the first `?`; everything after it is masked, so the path stays readable and the query doesn't.
  - **Kept as written:** identifiers, operators, empty strings, quoted property names (`"x-api-key":`), and `method` values. None of them carries a value a user typed as a secret.
  - **Not applied** to Prisma `RAW_QUERY` expressions (the SQL is what the user needs to see) or queue `DYNAMIC_NAME` expressions (the name expression itself). Both show only the unresolved expression, not neighbouring arguments.
  - **Alternatives rejected:** masking only strings that look like keys (a guess, and token formats vary); dropping `expression` (the user then can't tell which call it was).
- **Consequences:** no golden changed (no earlier fixture had a string outside a URL in an unresolved call). The secret-leak test checks the serialized `fake-secrets` graph for every planted value, from env files, compose, literal URL credentials, headers, a query string, and a wrapper argument. A hardcoded secret *inside the path* of an unresolved URL is still shown; that's a path segment, not a credential slot, and reads as one in code review.

## ADR-0039: M2 review fixes: budgets on repo-controlled evaluation, wider masking, no empty names
- **Context:** M2.11's fresh-eyes review ran hostile scratch repos against the built analyzer. Nine lines of consts that each repeat the last ten times took 70 s in the URL normalizer and put a 10-million-character label in the graph. Seven factories that each return ten calls of the next took 110 s in axios tracing (same shape in SDK tracing). `fetch("https:///x")`, `new Queue("")`, or a compose service named `""` produced an empty label or host, so validation threw and the whole analysis failed. `redactedText` kept `${base}&token=…` and `sign("/x", "key")` strings because they sat inside the URL before any `?`. Typed-queue `DYNAMIC_NAME` nodes copied the whole call, payload included.
- **Decision:**
  - **Budgets, not just depth limits.** `MAX_HOPS` bounds depth, not branching. The normalizer now counts expressions per `parts()` call (`MAX_STEPS` = 10,000) and caps literal text at `MAX_TEXT` = 2,048 characters. Either one produces an `overflow` hole, and the URL becomes `DYNAMIC_URL` with the detail "the URL is too large or too complex to read statically". Axios and SDK factory results are memoized per function, like queues' `byFactory` already was. Long labels and `NO_MATCHING_ROUTE` details go through `clip()`.
  - **No empty names reach the graph.** An empty host (also `user@` only, or only a port) is `DYNAMIC_URL` ("the URL has an empty host"). An empty queue name is `DYNAMIC_NAME` with its own detail. A compose service with an empty key is skipped with `COMPOSE_INVALID`.
  - **Masking:** inside a URL, literal text is kept up to the first `?`, `&`, `=`, or `#`. Strings passed to a call inside the URL are masked; only `new URL(…)` counts as building the URL. Queue `DYNAMIC_NAME` nodes use `redactedText` and keep only a name expression's own strings, never a whole call's or flow object's.
  - **Correctness fixes:** a called worker factory drops only its own `consumes` events; its publishes stay, as `DYNAMIC_NAME` when the name is the parameter. A config object only gives a `method` when it is `const` and never written (`x.a = …`, `delete`, `Object.assign`) in its file. A datasource with a literal `url` is never linked to a compose service by engine alone. An env value whose quote never closes is read as one line, so the keys after it still count.
  - **Kept as is:** an unbound wrapper parameter hole aligned to a `:param` route stays `exact`, per DESIGN.md §7.4's rule that a hole matches a param. A forwarded sub-path (`"/api/" + path`) and a path parameter look the same, and ADR-0032 already lists nested closures as not handled. M3's eval measures how often this misleads.
- **Consequences:** no golden changed, and cal.com's counts are unchanged. The review's repros are now tests: each stays under 20 s (in practice under 0.5 s).

## ADR-0040: Eval ground truth: labeled scope, call sites defined by the code, strict validation
- **Context:** M3.1 finalizes EVALUATION.md's label format before any repo is labeled. The draft left three things open that change the numbers: which call sites a label file promises to cover (so an unlabeled prediction is either "not scored" or "wrong"), where a call through a helper counts as made, and how a route is spelled so label and prediction compare as strings. The labeler must answer all three without looking at analyzer output (D10.3).
- **Decision** (`eval/src/format.ts`, the `@gitinside/eval` package):
  - **`scope` is required.** It lists the folders whose call sites are all labeled. Outside it nothing is scored; inside it, a route predicted at an unlabeled site counts as a false positive and is listed. This is the conservative choice: a labeling miss can only lower precision, and the list makes it visible so it gets fixed with a note.
  - **A call site is where the code fixes the URL's route:** the `fetch`/axios call when its URL is known there, else each call of the helper that supplies the path, however deep. That is a fact about the code, so the labeler can apply it blind. Where the analyzer stops early (`WRAPPER_DEPTH` after one level, ADR-0032), the label sits further out and the miss counts as a false negative, as it should.
  - **Routes use the analyzer's spelling** (`"POST /api/users/:id"`, `*slug`, `ALL`), and a target names the file that registers the route. Scoring ignores parameter names, so naming a param differently is not an error.
  - **Hand-written files are validated strictly:** unknown keys, unsorted or duplicate call sites, call sites outside the scope, non-canonical paths, and Next.js `[id]` syntax in routes are all rejected, and `repos.json` only takes permissive licenses and the five shapes. `validate` cross-checks file names and SHAs against `repos.json`.
  - **Alternatives rejected:** labeling the innermost `fetch` line (then a wrapper's one site would stand for many different routes); treating unlabeled predictions as unscored (a missed label would silently drop a wrong prediction); free-form routes (scoring would need fuzzy matching).
- **Consequences:** `eval/repos.json` starts empty and M3.2 fills it. A repo too large to label fully can be scored on a declared subset, and the report must state the scope.

## ADR-0041: Eval labels: one label per route reached at a call site with alternative URLs
- **Context:** labeling wanderlust (M3.4) found two calls whose URL is one of two literal paths: `axios.get(base + endpoint)` where `endpoint` is either `/api/posts/featured` or a template over `/api/posts/categories/`, and `axios.delete(base + url)` with `url` reassigned to an admin route in a branch. Each call really reaches two routes, but ADR-0040 allowed one label per call site. The graph already allows it: one `http` edge per `(from, to)`, each listing the site (GRAPH_SCHEMA.md).
- **Decision:** a call site may carry several labels, one per route reached, when the code fixes the alternatives statically. Labels are unique and sorted by call site, then target (`null` first, then route, file, line), enforced by `compareLabels` in `eval/src/format.ts`. Scoring treats each label as its own expected edge.
- **Alternatives rejected:** picking one route (the other is a real edge the eval would never ask for); `target: null` (claims the call reaches nothing in the repo, which is false); a `targets` array (a second shape for scoring to handle, and per-target notes get awkward).
- **Consequences:** WealthWise and foodie labels are unchanged (no such sites). `validate` now reports labels and call sites separately. A site the analyzer resolves to only one of its routes gets one TP and one FN, which is the honest count.

## ADR-0042: Eval scoring: what a prediction is, external hosts as abstentions, missing sites listed
- **Context:** M3.5 implements EVALUATION.md's scoring. The rules left open what counts as a prediction (the graph has `http` edges to routes and to `unresolved` nodes, but a literal-host `fetch` becomes an `external_call` edge, ADR-0034), how to compare route lines, and how to keep per-confidence numbers from double-counting recall. These must be fixed before the first scoring run (M3.6), so they can't be tuned to the result.
- **Decision** (`eval/src/score.ts`):
  - **Predictions are per edge site.** `http` → `route` predicts that route; `http` → `unresolved` and `external_call` → `external` both predict "no route in the repo". A `null` label with only such predictions at its site is a correct abstention. Other edge kinds are ignored.
  - **Route lines aren't compared.** The analyzer anchors a route at the method call (`router.get` column), labels at the registering statement; registering file + method + path (parameter names dropped) already identify a route uniquely within a file.
  - **False positives carry a kind** (`wrong-route`, `route-for-null-label`, `unlabeled-site`), and false negatives list what was predicted instead, so the report explains every miss.
  - **A label with no prediction at all is "missing"**, listed separately (it is also a false negative when it has a real target). It should never happen given "no call site dropped" (ADR-0034), so the list makes any break visible.
  - **Per-level recall uses all positive labels as the denominator**, so exact + pattern + heuristic recall add up to the overall recall; a level's own precision is TP / (TP + FP) at that level. Empty denominators are `null` ("n/a").
  - **Duplicates count once:** the same route predicted twice for one label (two sites on a line the label gives no column for) is one TP.
  - **Alternatives rejected:** comparing route lines (fails on harmless anchoring differences); counting external predictions for `null` labels as FPs or ignoring them (the analyzer correctly said "not in this repo"); per-level recall over labels "attempted" at that level (undefined for FNs, which have no confidence).
- **Consequences:** the scorer refuses a graph for another repo or commit (`ScoreError`). M3.6 adds the runner (analyze each pinned checkout, score, write the report).

## ADR-0043: Eval reports: byte-for-byte reproduction with a recorded run record
- **Context:** M3.6. EVALUATION.md asks that `pnpm eval` reproduce a committed report byte-for-byte, and also that the report state its date and machine. Those two can't both hold on another machine or day unless the report separates what depends on the run from what depends on the inputs. The analyzer's version string (`0.1.0`) also doesn't change with every analyzer commit, so it can't by itself say which code produced a report.
- **Decision** (`eval/src/run.ts`, `eval/src/report.ts`):
  - **The report is a pure function** of the pinned inputs plus a **Run** record (date, GitInside commit, machine). Scores, lists, and wording are all derived from the inputs, sorted, and printed with fixed formatting (`toFixed(1)` plus the raw fraction).
  - **`pnpm eval --check [report]`** reads the Run record back, refuses if the analyzer, schema, eval code (including labels and `repos.json`), or `pnpm-lock.yaml` differ from the recorded commit (committed or uncommitted), regenerates, and compares bytes. So "reproduced" means: the same code, at the recorded commit, gives the same report, on any machine.
  - **Dirty runs are marked** (`+ uncommitted changes`) and can't be checked. The workflow is: commit code, run the eval, commit the report.
  - **Checkouts** are shallow fetches of the exact SHA into `eval/.repos/<owner>__<name>`, with LFS smudging and `core.autocrlf` off so files have the same bytes on every OS; `eval/results/**` is pinned to LF for the same reason. The repos are only read.
  - **Missing labels with a real target** are listed once, under false negatives ("nothing predicted at the site"); the Missing list repeats only `null`-labeled dropped sites.
  - An on-demand **Eval** GitHub Actions workflow (`workflow_dispatch`) runs `--check`.
- **Alternatives rejected:** leaving the date and machine out of the report (EVALUATION.md requires them); comparing everything except the Run section (then a report could claim a commit it wasn't produced from); a JSON sidecar that the Markdown is re-rendered from (proves only the renderer, not the analysis).
- **Consequences:** a new report is needed whenever the analyzer, schema, labels, or lockfile change, which matches the rule that analyzer commits after M3 state their eval delta.

## ADR-0044: Owner label review sample: stratified per repo, seeded by date
- **Context:** M3.7. D10.3 has Abhinav review a random 20% of the drafted labels, chosen by a seeded shuffle with the issue's date as the seed (EVALUATION.md §1). Left open: the sampling unit, whether to sample across all repos at once, and which generator, so the list can be regenerated anywhere.
- **Decision** (`eval/src/sample.ts`, CLI `review-sample`):
  - **The unit is a call site,** with every label at it, since a multi-route site (ADR-0041) is one judgment about one piece of code.
  - **Stratified per repo:** ⌈20%⌉ of each repo's call sites, each repo shuffled with its own seed `<date>/<owner>/<name>`. A pooled draw of 29 of 142 could skip taxonomy (8 sites) entirely; stratifying costs one extra site (30) and checks every labeler pass.
  - **Generator:** FNV-1a 32-bit hash of the seed string into mulberry32, Fisher–Yates. Integer-only arithmetic, so the same on every platform and Node version; no dependency.
- **Alternatives rejected:** one pooled shuffle (can miss a repo); `Math.random` or a time seed (not reproducible); sampling labels instead of sites (splits one judgment in two).
- **Consequences:** the list in the review issue can be checked by anyone with the committed labels and the issue's date. Corrections go into the label files with a `notes` entry and `reviewedBy`, then a new report is generated.

## ADR-0045: M3 fresh-eyes review fixes to the eval harness
- **Context:** the M3.8 review (a context-free subagent, `m2..HEAD`) found no high-severity issues and confirmed the committed report reproduces. It found one real bug and eight latent gaps, five confirmed by running.
- **Decision:**
  - **`--check <path>` resolves against `INIT_CWD`** (where `pnpm` was run), not the eval package. The report's own "Reproduce" command failed with ENOENT before.
  - **Checkouts are reset and cleaned** (`reset --hard`, `clean -ffdx`) on every run, and checked out with `core.symlinks=false` on every OS. Stray or ignored files (a reader's `node_modules`, a `.env`) could otherwise reach the analysis, and Linux and Windows would disagree on symlinks.
  - **Wrong duplicates count once, like right ones:** when the label names only the line, the same wrong route at two columns is one FP, not two.
  - **Labels scoring can't tell apart are rejected** by `format.ts`: two routes at one site with the same `routeKey`, or `null` mixed with a route at one site (the `null` label was never scored). No committed label file had either.
  - **Report wording is derived** from the number of repos, `labeler`, and `reviewedBy`, instead of being fixed text.
  - **The Eval workflow** gets `permissions: contents: read` and `persist-credentials: false`.
  - **Newest report** is chosen by date, then version numerically (`0.10.0` after `0.9.0`).
- **Not changed:** a same-day rerun replaces that day's report rather than refusing. Git history keeps the old one, the Run record names the code, and the "re-run `pnpm eval` after any input change" rule (ADR-0043) would otherwise need a new name scheme. The review's other suggestion, summarizing review disagreements in the report, waits until the review exists (planning #1).
- **Consequences:** the report was regenerated. Its numbers are unchanged; only the Run commit and the derived wording can differ.

## ADR-0046: Viewer package scaffold: React 19, Vite library mode, Storybook 8, theme on one attribute
- **Context:** M4a.1 needs `packages/viewer` (ROADMAP M4a) for `apps/web` (Next.js, M5) and Storybook, with visual tests in dark and light later (M4a.8).
- **Decision:**
  - **React 19** as a peer dependency, so the Next.js app supplies the single copy (Next 15 ships React 19). React Flow (ADR-0011) is added when the graph canvas arrives (M4b).
  - **Vite library mode** builds one ES module bundle with React external; `tsc --emitDeclarationOnly` writes the types into the same `dist/`. The package exports `dist/` like `@gitinside/schema`, so turbo's `^build` ordering works unchanged.
  - **Vite 5.4.21**, the version Vitest 2.1.8 already resolves. Two Vite copies made `plugins` fail typecheck under `exactOptionalPropertyTypes`.
  - **Storybook 8.6** (`react-vite`, `addon-essentials`, telemetry off). A preview decorator wraps every story in `ViewerRoot` with a `theme` global (toolbar, and `&globals=theme:light` in URLs for visual tests). CI builds Storybook on every push (TESTING.md).
  - **Theme = `data-theme` on `ViewerRoot`.** Tokens (M4a.2) will be CSS variables keyed on `[data-theme]`, so switching themes changes one attribute and re-renders nothing below it.
  - **Tests** use Vitest + jsdom + Testing Library; coverage threshold 70% (TESTING.md, "others").
- **Alternatives rejected:** `vite-plugin-dts` (an extra dependency for what `tsc` does); a React context for theme (every consumer re-renders on switch, and CSS couldn't see it).
- **Consequences:** `.storybook/` and the Vite configs are typechecked with the package (only `src/` is emitted). ESLint gives the viewer browser globals.

## ADR-0047: Design tokens in TS and CSS, checked against each other; Geist via external Fontsource imports
- **Context:** M4a.2 turns DESIGN_SYSTEM.md §4 into tokens for both themes, with self-hosted Geist. Components style with CSS, but canvas code (layout timing, SVG/PNG export, minimap) needs the same values in JS. The light theme had no values yet, only "tuned for AA".
- **Decision:**
  - **Two sources, one test.** `src/tokens.ts` (`themeTokens`, `scaleTokens`, `durations`, `cssVar`) and `src/styles/tokens.css` hold the same values; `tokens.test.ts` parses the stylesheet and fails on any drift. Hex values are lowercase because Prettier lowercases them in CSS.
  - **Scoping:** shared scales on `.gi-root`, colors on `.gi-root[data-theme="dark"|"light"]`, so nested roots override and the host page is never restyled. `:focus-visible` gets the 2px accent ring; `prefers-reduced-motion` zeroes every duration.
  - **Contrast is a test, not a review step.** In both themes, `text` and `text-muted` are ≥ 4.5:1 and the accent, layer, trace, and diff colors are ≥ 3:1 on the canvas and every surface (`contrast.ts`, exported for M4a.3's logo fallback). Light values keep each dark hue and lower its lightness until it clears the bar.
  - **New tokens beyond the brief:** `surface-raised` for elevation 2–3 (screenshots showed shadows alone don't separate levels on the dark canvas; it is white in light), `scrim` for the palette backdrop, `shadow-2`/`shadow-3`, line heights, and per-role radii.
  - **Fonts:** `@fontsource-variable/geist` and `geist-mono` (OFL 1.1) as dependencies, imported from `src/fonts.ts` and kept **external** in the library build. Vite's library mode inlines every asset, which made `style.css` 201 kB of base64 woff2 subsets; external imports let the app's bundler emit the files on its own origin and the browser load only the unicode-range subsets a page uses (Latin only in the screenshots). Tokens ship as `@gitinside/viewer/styles.css`.
  - **No `sideEffects` field.** A `["*.css", …]` list made Storybook's build drop both stylesheets; the default (everything has side effects) costs nothing at this size.
- **Alternatives rejected:** generating the CSS from TS at build time (an extra build step for ~40 values the test already guards); Google Fonts or the `geist` npm package's `next/font` loader (third-party fetch, or Next-only); subsetting fonts by hand.
- **Consequences:** `apps/web` (M5) must import `@gitinside/viewer/styles.css` and let its bundler resolve the Fontsource CSS. `trace` and `diff-changed` are both amber; they never share a screen today (diff mode vs trace), which the design gate should confirm.

## ADR-0048: Icons from the node's own fields; logos bundled from Simple Icons; contrast picks the fill
- **Context:** M4a.3 needs real technology logos and a custom glyph family (DESIGN_SYSTEM.md §3). Simple Icons 16.36 no longer ships several brands the analyzer can name (OpenAI, AWS, Microsoft SQL Server, Twilio, Slack, SendGrid, Postmark), and many brand colors are near-black or pale, so they disappear on one theme's tile.
- **Decision:**
  - **Lookup is from the node's own field only:** `service.framework`, `datastore`/`queue` `engine`, `external.host`. Hosts match a registrable suffix at a label boundary, longest suffix first. Anything unmapped gets its kind's glyph; nothing is inferred from paths or package names. `iconFor()` is pure and total over `GraphNode`.
  - **`simple-icons` is pinned and bundled.** brands.ts imports ~56 named icons and keeps only slug, title, hex, and path; Rollup tree-shakes the rest (the library's `index.js` is 66 kB, 28 kB gzipped). `@gitinside/schema` is a types-only dependency and stays external.
  - **Fill by contrast, per theme:** the brand color if it is ≥ 3:1 (WCAG 1.4.11) on the tile's `surface-1`, else `--text`. Both fills go on the element as custom properties and `icons.css` picks one by `data-theme`, keeping ADR-0046's "theme switch re-renders nothing".
  - **The tile never changes fill.** Checking a hover fill too (`surface-2`) turned Redis, GitLab, Spotify, and Supabase monochrome in light; node states will restyle the node around the tile instead (M4a.4).
  - **Glyphs:** 14 stroke-only glyphs on a 24px grid (1.5px, round caps/joins, no per-element paint, enforced by tests), including two fallbacks beyond the brief: `datastore` (cylinder) and `variable` (braces). Unresolved is a dotted ring with a question mark, echoing the dotted unresolved edge style.
  - **Layer ring:** the tile hairline mixes 60% of the layer color into `--border` (`color-mix`). Full-strength rings were louder than the logos in screenshots. Layer is also named in the legend and inspector, so the ring is never the only signal.
- **Alternatives rejected:** keeping `simple-icons` external (apps/web would depend on its bundler tree-shaking a 5 MB module); copying SVG files into the repo (loses version pinning and license tracking); drawing our own approximations of missing brands (trademark risk, and a wrong logo is a guess); a per-brand hand-picked dark/light color table (drifts from the tokens; the contrast rule is testable).
- **Consequences:** a logo that Simple Icons removes in a future version breaks the import at build time, never silently. Some brands are monochrome in one theme (e.g. React in light). The design gate should confirm that tradeoff. The library build's sourcemap embeds the whole simple-icons source (5 MB `index.js.map` in `dist/`, not shipped to browsers).

## ADR-0049: One DiagramNode component, three container tiers, states as combinable data attributes
- **Context:** M4a.4 needs node visuals for every kind in every state (default, hover, selected, dimmed, traced, diff added/changed/removed). States co-occur in the explorer (a selected node on a trace, a selected node that changed), and M4b's canvas (React Flow) will own positioning and events.
- **Decision:**
  - **One component, `DiagramNode`, picks the container from the kind** (`nodeTier`): services and modules are frames, datastores/queues/externals are icon-first, everything else is a card. Words come from pure helpers in `nodes/describe.ts` (`nodeLabel`, `nodeSubtitle`, `kindName`, `REASON_TEXT`, `nodeAccessibleName`), all from the node's own fields.
  - **A closed frame draws a stacked edge** (two box-shadows) meaning "there is more inside, break it down". An open frame is translucent (`color-mix` of the layer into `transparent`), so nested frames deepen the tint.
  - **States are data attributes** (`data-hover`, `data-selected`, `data-emphasis`, `data-diff`), styled in `nodes.css`, so they combine without prop explosions and a theme switch re-renders nothing. Border precedence is selected (accent) > traced (trace) > diff > hover; hover rules wrap tier qualifiers in `:where()` to keep the same specificity as the state rules after them. Traced adds a soft trace-colored glow that survives selection.
  - **Diff state is a worded tag on the node's top edge** ("Added", "Changed", "Removed"), not an inline badge: the first screenshots showed inline diff badges squeezing card names to "crea…" and clipping the route's method chip, and growing icon-first nodes. Color is never the only signal: the tag has the word, removed is also dashed, ghosted, and struck through, and the accessible name says "Added in this change".
  - **Unresolved nodes are dotted cards** on the canvas color, matching the dotted unresolved edge, with the reason in words (`detail` if the analyzer gave one).
  - **Inherited layer:** modules, files, and symbols have no layer in the graph, so the caller passes the service's layer; the node's own layer wins.
  - **Dimmed is 20% opacity** (UX.md trace mode), raised to 50% on hover so a dimmed node can still be read before clicking it.
- **Alternatives rejected:** one component per kind (11 near-identical components; tier is the real axis); a single `state` enum prop (can't express selected + traced); per-state class names (same thing with less readable selectors); recoloring the icon tile for states (ADR-0048: the tile's fill is what logo contrast was checked against).
- **Consequences:** `nodes.css` must keep taking every color from tokens (a test rejects literals) and every transition from duration tokens (so reduced motion is instant). M4b wraps `DiagramNode` in React Flow nodes and passes `tabIndex`/handlers through. Long route paths truncate with an ellipsis in narrow cards; the full label is in the `title` and the accessible name.

## ADR-0050: Edges drawn from route points with our own geometry; labels as HTML pills; flow via CSS motion path
- **Context:** M4a.5 needs edges for every confidence level and state (hover, selected, traced, dimmed, diff, broken), with labels, arrowheads, and flow particles (DESIGN_SYSTEM.md §3, UX.md). M4b will route edges with ELK and render them inside React Flow, which isn't a dependency yet (ADR-0046).
- **Decision:**
  - **`DiagramEdge` takes route points** (ELK's start, bend, and end points), not a ready-made path. Pure `edgeGeometry()` builds the line with rounded bends (radius 10, shrunk on short jogs), ends it at the arrowhead's base so the stroke never pokes through the tip, and returns the arrowhead, an open chevron, the pattern dot, the label point (half the length), and the full flow path. Coordinates are rounded to 0.01px, so the same points always give the same SVG text. Our own arrowheads replace SVG `<marker>`s, whose color can't follow the stroke on every browser (`context-stroke` support is patchy).
  - **Line style is confidence:** solid (exact), solid with a dot 7px off the source (pattern), dashed 6/4 (heuristic), dotted round caps (unresolved, with an open chevron arrowhead). Broken overrides the line with a pulsing red dash, because UX.md specifies that look.
  - **Color is the source's layer**, mixed 70% into `--text-muted` at rest and full on hover. A test computes that mix for every layer and theme and holds it to 3:1 on the canvas and both surfaces (WCAG 1.4.11; edges are essential graphics).
  - **Selected and traced get a halo** (the hit-area stroke tinted 22% / 16%), not only a color: screenshots showed a selected frontend edge was indistinguishable from hover in light, where the frontend blue sits next to the accent.
  - **Labels are a separate HTML pill (`EdgeLabel`)**, positioned by the caller at the geometry's `mid`, the way React Flow draws labels above its SVG layer. They say only what the analyzer knows: `POST /api/orders · HTTP` (method chip + mono path), `reads id, total`, the reason in words when unresolved, "22 calls" when aggregated, a leading "Added/Changed/Removed" in diff mode, and the broken text when broken. No guessed protocol: `external_call` reads "calls API", never "HTTPS". The pill is `aria-hidden`; the edge's accessible name carries the same words plus both ends and the confidence.
  - **Flow particles** are two circles per edge animated along the path with CSS `offset-path` (one lap per three trace hops, staggered), with a canvas-colored ring so they show on a line of the same color. Reduced motion hides them and stops the broken pulse; the duration tokens already go to 0ms.
- **Alternatives rejected:** taking an SVG path string (we couldn't compute the arrow direction, label point, or pattern dot without parsing it); SVG `<marker>` arrowheads; SMIL `<animateMotion>` (ignores CSS, so reduced motion couldn't turn it off); labels inside SVG `<text>` (no mono/sans mix, chips, or ellipsis); a stroke color separate from the layer (the brief makes layer the edge flow color).
- **Consequences:** M4b's React Flow custom edge passes ELK's points and renders `EdgeLabel` through its label renderer; ELK should get label sizes so labels never cover short edges (the first screenshots showed pills swallowing 128px edges). `edges.css` follows the same token-only, duration-token-only rules as `nodes.css`, enforced by `edgesCss.test.ts`.

## ADR-0051: Chrome as controlled, composable shells; the legend built from the canvas's own tables
- **Context:** M4a.6 needs the explorer's chrome (top bar, inspector, breadcrumbs, minimap shell, legend, command palette shell, buttons and toggles) for the design gate, before M4b wires real state (selection, drill-down, fuzzy search, Shiki, trace player). DESIGN_SYSTEM.md §1 asks for quiet, Linear-like chrome so the canvas stays the hero.
- **Decision:**
  - **Every component is controlled:** it renders state from props and reports changes through callbacks (`onSelect`, `onChange`, `onPick`, `onActiveIndexChange`). M4b owns the state; stories use `useState` so the prototype is clickable. No component keeps its own UI state.
  - **The inspector is a set of parts** (`Inspector`, `InspectorHeader`, `InspectorSummary`, `InspectorSection`, `FactList`, `ConnectionList`, `CodePreview`, `InspectorActions`), not one component with a prop per section, because each selection kind shows different sections (a route has callers and code, an unresolved call has a reason, a service has Break down). The summary sentence is a prop; templating it from graph facts is M4b.5.
  - **The legend is generated from the canvas's tables:** layers from `LAYER_NAMES`, line styles drawn by `DiagramEdge` itself, confidence words from `CONFIDENCE_TEXT`, diff words from `DIFF_TEXT`. The schema stays a types-only import (ADR-0048), so a test checks those tables' keys against the schema's enums instead of importing zod into the bundle.
  - **Accessible patterns:** the palette is a modal dialog with a combobox field (`aria-activedescendant`, focus stays in the field) and a listbox; the diff view is a radio group (one tab stop, arrow keys); switches use `role="switch"`; breadcrumbs mark the current level `aria-current="location"`; key caps are `aria-hidden` and buttons carry `aria-keyshortcuts`.
  - **One primary button per surface:** "Trace a request" in the top bar (trace is the signature), "Trace from here" or "Break down" in the inspector. Primary text is the canvas color on the accent (≥ 4.5:1 in both themes, tested).
  - **Interface icons are their own set** (`uiIcons.tsx`), following the glyph family's grid, caps, and no-fill rules but with a 2-unit stroke: at 16px the glyphs' 1.5 rendered as hairlines in the first screenshots.
  - **GitHub links are permalinks only:** `githubLineUrl` returns nothing without a SHA rather than linking a branch that may have moved, and encodes each path segment.
- **Screenshot review changed:** the diff view's segmented control overlapped the search field (the top bar's outer columns now never shrink below their content; search gives way); the legend overflowed a 600px canvas (now two columns, 560px wide, shorter copy); a long path fact wrapped mid-word (facts truncate with the full value in the tooltip); the legend toggle became a labeled "Legend" button; the Layout story's gaps were widened so edge labels don't cover nodes.
- **Alternatives rejected:** uncontrolled components with internal state (M4b would have to fight them for deep links and keyboard handling); a hand-written legend (drifts from the canvas); importing the schema's zod enums at runtime (adds zod to the viewer bundle for four lists); reusing the kind glyphs at 16px for chrome (too faint); a native `<dialog>` for the palette (jsdom support is partial and the shell needs no focus trap until M4b.7 opens it for real).
- **Consequences:** M4b.4–M4b.7 fill these shells: zoom and minimap get real viewport state and dragging, the inspector gets the summary template, Shiki inside `CodePreview`'s frame, and the trace player, the palette gets fuzzy matching (its `matches` ranges feed `highlightSegments`) and a focus trap. The top bar has no narrow layout yet; under 880px (UX.md) is M4b work. `chrome.css` follows the token-only, duration-token-only rules, enforced by `chromeCss.test.ts`.

## ADR-0052: The design-gate prototype runs on real analyzer output, with a fixed layout and a checked trace script
- **Context:** M4a.7 asks for a static clickable prototype on a fixture graph (drill one level, select, a fake trace) so Abhinav can judge the visual language at the design gate. No existing fixture had a whole request path, and ELK, React Flow, pan/zoom, and the trace BFS are M4b work.
- **Decision:**
  - **A new fixture, `fixtures/shop-demo`**, small but end to end: a Next.js web app whose `/checkout` page calls `placeOrder`, which fetches `${NEXT_PUBLIC_API_URL}/api/orders` (`heuristic`) into an Express route handled by `createOrder`, which writes a Prisma `Order` (stored in a compose Postgres, linked by host) and calls Stripe; plus a `CMS_URL` fetch that stays `unresolved`. It joins the analyzer's golden, determinism, secret-leak, and no-call-site-dropped suites like every fixture, with its own semantic assertion. The prototype draws **its golden `expected.json`**; the stories load it and the fixture's source files (for code previews) through `import.meta.glob`. Nothing on the canvas is hand-drawn.
  - **A small view model (`prototype/model.ts`)**: visible nodes are the root's children plus the children of one open top-level node; graph edges are lifted to their innermost visible ends, one drawn edge per (from, to, kind), with the **weakest** confidence among them (a line never claims more than its weakest link), a count label when aggregated, and edges that land inside one box dropped from the canvas. `imports` are hidden at these levels (they repeat the calls). Closed frames count pages, routes, models, and unresolved calls inside them, so the CMS call is visible as a dotted "1 unresolved call" badge before drilling.
  - **A fixed column layout (`prototype/layout.ts`)**: top-level nodes in columns by layer, read in request order (frontend → backend → data and outside APIs), the open node's children stacked inside its frame, edges leaving facing sides with one bend halfway, and parallel edges between one pair 18px apart with their labels spread along the line (the first screenshot had `reads` and `writes` pills on top of each other). The whole diagram is scaled to fit the canvas (40–100%), shown in the zoom control. Boxes glide with `--duration-layout`, children emerge from the frame's center, so reduced motion makes it instant.
  - **The trace is a script, checked against the graph** (`prototype/trace.ts`): a start node and the IDs of the edges it follows. `checkTrace` throws if a hop names a missing edge or doesn't continue the path, so the "fake" trace can't show a connection the analyzer didn't find. Each step's title, file:line, code, and confidence come from the edge. Hops inside a closed box say "Happens inside @shop/web; break it down to watch it", with the button.
  - **Interactions** follow UX.md: click/Space selects (the inspector shows the node itself; the canvas marks the visible box holding it), double-click/Enter/**Break down** opens, Esc and the breadcrumb go up, T or the top-bar button traces, Esc order is trace → level → selection, choosing a connection in the inspector drills to it, and a live region announces the selection.
  - **Nodes stay in one stable DOM list**, layered by z-index (open frame, edges, boxes, labels). An opened frame still swaps its element (a closed frame is a `div`, an open one a `section`), so focus is moved back onto it after it opens or closes; without that, the T and Esc keys stopped working after a double-click in the browser (jsdom didn't show it).
- **Alternatives rejected:** a hand-made sample graph (the prototype would show what we hope the analyzer finds, not what it finds); extending an existing fixture (would churn goldens other tests pin); pulling in ELK or React Flow now (M4b.2 decides how they're wired; the gate is about the look); computing the trace by BFS (M4b.6, with call order and depth limits from UX.md); the strongest confidence for aggregates (would show a solid line over a heuristic hop).
- **Consequences:** `ExplorerPrototype` isn't exported from the library; M4b replaces the layout with ELK, the script with the BFS, and the summaries with M4b.5's templates, keeping the model's lifting rule as a starting point for M4b.1. Not in the prototype: pan and zoom, the palette (the search field is inert), filters, share, a play button in the trace player, and drilling below one level. `prototype.css` follows the token-only, duration-token-only rules (`prototypeCss.test.ts`).

## ADR-0053: Visual regression: every story in both themes, captured and compared in the pinned Playwright container
- **Context:** M4a.8 asks for a visual regression baseline of the stories in light and dark, compared in Linux CI only (TESTING.md), so font rendering is stable. The development machine is Windows and its Docker daemon isn't available to the loop, so baselines can't be recorded locally.
- **Decision:**
  - **The cases come from the built Storybook's `index.json`** (`visual/cases.ts`): every story (docs pages skipped) × dark, light, sorted by story id, named `<story-id>--<theme>.png` under `packages/viewer/visual/baselines/`. A new story is a new screenshot with no list to maintain; an index with no stories, an unknown format, or an id that isn't a safe file name throws instead of passing with zero tests.
  - **One Playwright spec** (`visual/stories.visual.ts`) serves `storybook-static/` from a loopback static server (`visual/serve.mjs`, files inside the build only), opens each story's iframe with `globals=theme:<t>`, and before the full-page screenshot checks: the decorator's root carries the theme, tokens.css applied (non-transparent background), Geist loaded, the themed root covers the whole page, and no page or console errors. Viewport 1280×800 at scale 1, UTC, en-US; CSS animations and transitions disabled (all viewer motion is CSS), caret hidden. Strict comparison (Playwright's defaults, no pixel allowance).
  - **Linux only, in `mcr.microsoft.com/playwright:v1.64.1-noble`**, the same version as `@playwright/test`. The spec skips itself on other systems. CI's `visual` job compares; the on-demand **Visual baselines** workflow re-captures all of them in the same image and uploads them as an artifact, which is downloaded (`gh run download`), looked at, and committed with the reason. No workflow writes to the repo.
  - **The Storybook preview's root grows with its story** (`.storybook/preview.css`: `fit-content`, at least the frame): the first trial run showed the 2,200px-wide state matrices drawn on white past the viewport edge. Storybook only; `ViewerRoot` itself is unchanged.
- **Alternatives rejected:** baselines from Windows (font hinting differs from CI, so every run would fail); a per-platform suffix with baselines for both (TESTING.md keeps comparison on Linux only); the Storybook test runner (`@storybook/test-runner` adds Jest and a second browser setup for the same screenshots); a CI job that commits baselines (pushes to a protected `main` and skips the human look); a pixel tolerance (hides the small changes, a 1px border, that the gate cares about).
- **Consequences:** a UI change that moves pixels fails CI until baselines are re-captured with the workflow and committed with the reason in the body. A trial run on Windows (skip temporarily disabled, output deleted) matched itself on three runs, so the stories render deterministically; Linux CI determinism is confirmed by the `visual` job comparing against baselines captured by the workflow. M4b.14 adds key explorer screens to the same harness.

## ADR-0054: M4a review fixes: reading order, focus that survives removed controls, trace color for graphics only
- **Context:** the M4a milestone review (a fresh-eyes subagent plus a click-through of the built Storybook in Chromium) found keyboard and contrast problems that the jsdom tests and screenshot reviews had missed.
- **Decision:**
  - **Nodes render in reading order.** `layout()` returns `order`: columns left to right, top to bottom, an open frame's children right after it. The explorer renders that list, so Tab follows the picture (UX.md, WCAG 2.4.3); before, it followed the graph's ID order (db → Stripe → api → web). Boxes don't overlap except the open frame, which z-index layers, so pixels don't change.
  - **Focus is put back when a trace control disappears.** Starting, stepping, or ending a trace can remove or disable the focused button ("Trace from here", "Next step" on the last step, the whole step player on Esc). Focus then fell to the page, and T and Esc stopped working (found in the browser: the second Esc did nothing). When that happens, focus moves to the current step while tracing, else to the box the trace started from. Esc closes the legend first (UX.md order), returning focus to its button.
  - **`--trace` is a graphics color, not a text color.** It's tested to 3:1, and the current step's number used it as 13px text (3.71:1 in light). The step is now marked with a 3px trace bar, its text stays `--text`, and a CSS test forbids `color: var(--trace)`.
  - **Smaller fixes:** inspector rows keyed per edge (a node reached by `reads` and `writes` had a duplicate React key); `brands` sorted with `compareStrings`; CI's default token is `contents: read`; the visual spec fails on a baseline no story produces and checks Geist Mono loaded wherever it's used.
- **Deferred to M4b (recorded in the M4a review):** a real role pattern for canvas nodes (`aria-expanded`/`aria-pressed` or a tree) with arrow keys (M4b.11); the palette taking and trapping focus (M4b.7); a separate fonts entry so the library imports in Node without CSS (M5.2, when apps/web consumes it).
- **Consequences:** the tracing stories' pixels change (the step marker), so their Linux baselines are re-captured with the Visual baselines workflow.

## ADR-0055: Production accounts, secret names, and where each secret lives
- **Context:** M5.1 opens the signup issues (planning #3 Oracle, #4 Neon, #5 R2, #6 Vercel, #7 DNS). Abhinav enters every secret himself (SECURITY.md §4), so the names he types into Vercel and the VM have to be fixed before the code that reads them exists.
- **Decision:**
  - **Environment variable names:** `DATABASE_URL` (Neon pooled, for serverless functions and the worker), `DATABASE_URL_UNPOOLED` (Neon direct, migrations only; the names Vercel's own Neon integration uses), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (`gitinside-snapshots`), `WORKER_URL`, `ENQUEUE_HMAC_SECRET` (32 random bytes, base64url, generated by Abhinav). M5.2 adds them to `apps/web/.env.example` (names only); a rename after that is commented on #6.
  - **Where they live:** Vercel env vars (Production only, marked Sensitive) and the VM's root-only `/etc/gitinside/worker.env`; until then, Abhinav's password manager. **No production secret is ever in a local file inside the repo**: development and CI use Docker Postgres and a local storage stand-in, so a leaked `.env.local` can't reach production.
  - **Names:** the site at `gitinside.abhinavgonthina.dev` (CNAME to the record Vercel shows); the enqueue API at `worker.gitinside.abhinavgonthina.dev` (A record to the VM, Caddy TLS on 443, DNS-only if the zone is on Cloudflare).
  - **Accounts:** Oracle Free Tier (never upgraded to Pay As You Go), `VM.Standard.A1.Flex` 4 OCPU / 24 GB Ubuntu 24.04, ingress 443 plus 22 from Abhinav's IP; Neon free in `us-east-1` (next to Vercel's default `iad1`); R2 bucket in the Standard class (Infrequent Access has retrieval fees), public access off, an API token scoped to that bucket with Object Read & Write; Vercel Hobby with its GitHub app limited to this repo.
- **Alternatives rejected:** a shared `.env.production.local` in the repo folder (one wrong `git add -f` from a leak, and dev would point at production); one R2 token for all buckets (more than the worker needs); public r2.dev access (rate-limited and unneeded while the web app serves snapshots).
- **Consequences:** R2 is the one service that bills past its free tier instead of stopping, recorded as P-1 in the planning repo's PROPOSALS.md; M5.12's quota check and retention are what keep it at $0. M5.13 is blocked on #3–#7; M5.2–M5.12 are built and tested locally. Vercel's project import waits for M5.2, which comments on #6 when it lands.

## ADR-0056: apps/web on Next.js 16 App Router; the viewer as a client bundle with fonts in their own entry; theme by cookie; nonce CSP
- **Context:** M5.2 is the first app consuming `@gitinside/viewer`. The built `index.js` imported the Fontsource CSS (ADR-0047), so plain Node (server rendering, a test, a script) couldn't import it, and its components use hooks, so React Server Components refused them. SECURITY.md T10 asks for a strict CSP, and DESIGN_SYSTEM.md §1 for dark first with no flash.
- **Decision:**
  - **Two library entries.** `@gitinside/viewer` (components; no CSS import left, the viewer's own stylesheet is extracted to `styles.css`) and `@gitinside/viewer/fonts` (only the Fontsource imports, still external so the app's bundler self-hosts the woff2). The app's root layout and Storybook's preview import the fonts once. `index.js` starts with `"use client"`, so server components can render viewer components with serializable props. Tested on the built output from apps/web (a Node child process imports it) and on the source (`index.ts` imports no package CSS).
  - **`<html>` is the viewer's themed root** (`.gi-root` + `data-theme`), so the site uses the diagram's tokens. The theme is a `gi-theme` cookie read by the root layout on the server; anything but `light` is dark. The switch sets the attribute and the cookie client-side, no inline script.
  - **Nonce CSP from `proxy.ts`** (Next.js 16's middleware): a fresh 16-byte nonce per page response, `script-src 'self' 'nonce-…' 'strict-dynamic'`, nonced styles plus `style-src-attr 'unsafe-inline'` (the viewer positions nodes and passes theme fills via inline custom properties), `default-src`/`font-src`/`connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`; `unsafe-eval` only under `next dev`. Other security headers on every response from `next.config.ts`; no `X-Powered-By`. Pages therefore render per request (they read the cookie anyway).
  - **Repo URLs parsed with GitHub's own name rules** (`lib/repoUrl.ts`): https/scheme-less/`www.`, deep links, `.git`, `git@github.com:`, `owner/repo`; other hosts, credentials, ports, GitHub's reserved first segments, and names GitHub disallows are refused. `/<owner>/<repo>` 404s on names that fail, never echoing them. Until M5.6 the form opens the repo page, which shows UX.md's "temporarily unavailable" state.
  - **Testing:** Vitest + Testing Library for components and pure code; Playwright E2E (`apps/web/e2e`) against `next build` + `next start` checks what unit tests can't (every script carries the nonce and hydration still runs, Geist and the tokens load, the theme cookie survives a reload, the 404). CI runs it in the pinned Playwright container (`web-e2e` job).
  - **Vercel:** `apps/web/vercel.json` builds from the repo root with turbo (so the viewer and schema are built first), region `iad1` next to Neon `us-east-1`.
- **Alternatives rejected:** `next/font` (it would duplicate the Fontsource files the viewer already pins); a theme script in `<head>` (needs a CSP hash or nonce on every page and still reads storage before paint); `transpilePackages` on the viewer source (the app would build a different artifact from the one the library tests); `'unsafe-inline'` scripts.
- **Consequences:** the landing page has no demo gallery yet (M9.1) and no "Sign in" (M8). Static generation is off for pages, which is fine at this traffic; the image endpoint (M5.9) and API routes aren't behind the proxy.

## ADR-0057: `packages/db`: Drizzle schema with integrity in the database, committed SQL migrations, PGlite locally and Postgres in CI
- **Context:** M5.3. Both `apps/web` (Vercel) and `apps/worker` (VM) read and write the DESIGN.md §10 tables, production is Neon (ADR-0055), and Docker's daemon doesn't run on the development machine.
- **Decision:**
  - **One shared package, `@gitinside/db`:** `src/schema.ts` (the tables), `createDb(url)` (postgres.js with `prepare: false`, so the same client works through Neon's pooled PgBouncer endpoint), `runMigrations(url)`, and a `migrate` CLI that reads `DATABASE_URL_UNPOOLED`, else `DATABASE_URL`, and never prints the URL.
  - **Migrations are generated SQL, committed** (`packages/db/drizzle/`, `pnpm --filter @gitinside/db generate`), applied by Drizzle's migrator in order and recorded in its own table; never `drizzle-kit push`. A test diffs the schema against the last committed snapshot with drizzle-kit's API, so a schema change without its migration fails.
  - **Integrity lives in the database:** full lowercase 40-hex SHAs; a status check that ties each analysis state to its columns (`done` ⇒ snapshot + finish time, `failed` ⇒ error code + finish time, `running` ⇒ start time, `queued` ⇒ none); non-negative counts; positive PR numbers; owner/name unique ignoring case (as on GitHub) with GitHub's numeric ID as the stable identity; deleting a repo or user cascades to everything hanging off it, deleting an installation only unlinks its repos (M8.5 deletes their data explicitly).
  - **IDs:** random UUIDs (`gen_random_uuid()`), because analysis IDs appear in URLs (`/api/jobs/:id`) and sequential ones would let anyone walk other people's jobs. GitHub IDs are `bigint` read as JS numbers (they're below 2^53; already above 2^31).
  - **`rate_limits.key` is opaque:** callers (M5.6) store a keyed hash of the IP, never a raw address.
  - **Tests:** with `TEST_DATABASE_URL` set (CI's `postgres:17-alpine` service), each test file creates its own database, migrates it with `runMigrations`, and drops it; without it, PGlite (Postgres compiled to WebAssembly, a dev dependency) applies the same SQL in memory, so `pnpm test` needs no Docker. CI also runs the built `migrate` CLI twice (the second must be a no-op). `infra/docker-compose.dev.yml` runs the same image locally on 127.0.0.1 with a fixed local-only password.
- **Alternatives rejected:** `@neondatabase/serverless` (HTTP driver; ties dev and CI to Neon or a proxy); `drizzle-kit push` (no reviewable history, can drop columns); integer IDs; testing only on PGlite (not the server production runs) or only in CI (nothing runnable locally without Docker); keeping the table code inside `apps/web` (the worker needs it too).
- **Consequences:** the access-cache TTL (60 s) and rate-limit windows are enforced by readers comparing timestamps, not by the database. Retention (M5.12) uses the `(repo_id, created_at)` index.

## ADR-0058: `apps/worker` starts with a tar extractor we parse ourselves
- **Context:** M5.4a. The worker unpacks GitHub tarballs of untrusted repos (SECURITY.md T2, T3). Tar libraries have a history of path-traversal and link-following bugs (node-tar's 2021–2024 CVEs), and their safety depends on options and filters set correctly by the caller. The format itself is small: 512-byte headers, ustar `prefix`, pax `x`/`g` records, GNU `L` long names.
- **Decision:**
  - **`extractTarball(source, dest)` parses the tar stream itself** (`apps/worker/src/extract.ts`, no dependency) behind `node:zlib` gunzip, and does every filesystem write: `mkdir` for folders and `open(…, "wx", 0o644)` (create-exclusive, so no overwrite) for files, after resolving each path and checking it stays under `dest`.
  - **What fails the job vs. what is skipped.** Paths git can't record (absolute, `..`, NUL) fail with `TAR_UNSAFE_PATH`: they only appear in crafted archives. Symlinks, hard links, devices, FIFOs, unknown types, and names the worker can't represent safely (backslash, control characters, segments over 255 bytes, paths over 4,096) are **skipped and listed** in the result, because real repos have symlinks. Since no link is ever created, a later entry under a skipped link's name becomes an ordinary folder inside `dest`.
  - **Limits:** 500 MiB counted on the decompressed stream (including anything after the end marker, so a gzip bomb stops while streaming; a header declaring more fails before reading), 100,000 entries (pax/GNU records not counted), metadata records ≤ 1 MiB. Codes `LIMIT_SIZE`, `LIMIT_ENTRIES`.
  - **Strict integrity:** header checksums, the end-of-archive marker (a cut-off download fails instead of yielding half a repo), one top folder (GitHub's `owner-repo-sha7/`, stripped), no duplicate or conflicting entries; anything else is `TAR_INVALID`, as is bad gzip.
  - **Files over 2 MB are written in full.** The analyzer's inventory then skips them with the same `SKIPPED_LARGE` warning a local checkout gets, and workspace detection can still read anything it reads directly. The 500 MiB cap bounds the disk use.
  - **Tests** build hostile archives byte by byte with a test-only tar writer (`tar.testkit.ts`), and extract a real `git archive` tarball (pax global header, like GitHub's) to compare against the committed blobs.
- **Alternatives rejected:** `tar` (node-tar), whose `filter`/`strict`/`preservePaths` options must all be set right and which creates links by default; `tar-stream` (safe to drive by hand, but buffers whole pax headers and adds a dependency for ~150 lines); skipping large files at extraction (the analyzer couldn't warn about them, so worker and CLI graphs would differ).
- **Consequences:** skipped entries aren't in the graph's warnings yet; M5.4d/M5.5 put the list in `analyses.stats`. GNU sparse files and multi-volume archives are unsupported (GitHub doesn't produce them). On failure `dest` is partly written; the job runner deletes the job directory either way (SECURITY.md §3).

## ADR-0059: Analysis runs in a child process sandboxed by Node's permission model, an empty env, and a network guard
- **Context:** M5.4b. Each job analyzes untrusted text in a process that must not outlive 5 minutes or 3 GB (SECURITY.md T3), read the worker's secrets, start processes (T1), or use the network (T4). The analyzer is synchronous TypeScript-compiler work for most of a run, so an in-process timer can't stop it. Node 22 (the CI and production runtime) has a stable permission model for the filesystem, child processes, worker threads, and addons, but not for the network (that arrives in Node 25).
- **Decision:**
  - **`runAnalysis(job, options)`** (`apps/worker/src/runner.ts`) spawns `node child.js` (`process.execPath`, `spawn`, not `fork`, so no IPC channel and no inherited `execArgv`) and never throws for the child's behavior; it returns `{ ok, stats }` or `{ ok: false, code, message, stderrTail }`.
  - **Limits:** `--max-old-space-size=3072`; a wall-clock timer that sends `SIGKILL` at 5 minutes (also when an `AbortSignal` fires, for worker shutdown). CPU share is the container's job (M5.10); the queue runs 2 jobs at most.
  - **Permission model:** `--permission` with `--allow-fs-read` for the installed app root (code, analyzer, TypeScript's libs; it must hold no secrets) and the job's `src`, `--allow-fs-write` for exactly the output file. Paths are passed through `realpath` first. Child processes, worker threads, addons, and WASI are refused by default.
  - **Environment:** `{}`, so no secret, `NODE_OPTIONS`, or proxy variable reaches the child (on Windows libuv adds its fixed list of system variables).
  - **Network:** `netguard.ts`, preloaded with `--import`, replaces socket, TLS, UDP, listen, `http(s)`, `dns`, `fetch`, `WebSocket`, and `EventSource` entry points with non-writable functions that fail with `ERR_NETWORK_DISABLED` (ESM named imports re-synced). It's defense in depth against our own bugs; the boundary against an attacker is the container's egress allowlist (M5.10).
  - **Protocol** (`protocol.ts`): the job goes in as one JSON argument; the child writes the graph to `out` and prints one JSON report line (stats with per-stage timings, or an `AnalysisError` code). The parent validates it like input and requires exit 0, stdout ≤ 64 KiB, and a graph file of the reported size.
  - **Codes:** the analyzer's own (`LIMIT_FILES`, `INVALID_GRAPH`) pass through; `LIMIT_TIME` (killed at the limit), `LIMIT_MEMORY` (V8's heap-limit message on stderr), `CANCELLED`, and `ANALYZER_CRASHED` for anything else. User-facing messages are fixed text or the analyzer's own; the stderr tail (8 KiB) is for logs only.
  - **Tests** run the compiled child (a Vitest global setup builds `dist/`): the real analyzer on a copied fixture must write the golden bytes, and a probe script run in the same sandbox checks the kill on a busy loop, the heap cap, cancellation, malformed reports, every blocked network API (a local server sees no connection), denied reads outside the roots, denied writes besides `out`, denied `spawnSync` and `Worker`, and the empty environment.
- **Alternatives rejected:** `worker_threads` with `resourceLimits` (shares the process, its env, and its file access; a hung thread is harder to kill cleanly); `fork` (IPC channel and inherited flags for no benefit); OS sandboxes (`unshare -n`, seccomp per child) that need privileges the non-root container doesn't have; relying on the container alone (one bug would expose the worker's own secrets and files to the analysis).
- **Consequences:** the app root's read access means no secrets may live under it (production keeps them in `/etc/gitinside/worker.env`). If the worker process itself dies, its child isn't killed by us; in production the container's restart takes it down. `netguard.ts` runs only in child processes, so it shows 0% in the in-process coverage report; the probe test is its coverage.

## ADR-0060: The enqueue API: plain `node:http`, an HMAC over timestamp + method + path + body, two secrets, derived job IDs
- **Context:** M5.4c. The web app (Vercel) must queue jobs on the VM without Redis ever being public (ADR-0007, SECURITY.md T8: HMAC over body + timestamp, ±5 min; §4: secrets rotate without downtime). Three routes: `POST /enqueue`, `GET /jobs/:id`, and a health check (DESIGN.md §11, §13).
- **Decision:**
  - **`node:http`, no framework** (`apps/worker/src/api.ts`). Three routes don't need Express, and every dependency on the one public port is attack surface (T12). Server timeouts: headers 10 s, whole request 15 s, keep-alive 5 s. Tests drive the handler with Supertest.
  - **Signature** (`hmac.ts`): `X-GitInside-Timestamp: <unix seconds>` and `X-GitInside-Signature: v1=<hex HMAC-SHA256>` over `v1\n<ts>\n<METHOD>\n<path?query>\n<raw body>`. Binding the method and path (not only the body, as T8 first said) stops a captured `GET /jobs/A` signature being used for `/jobs/B`. Compared with `timingSafeEqual` against every accepted secret, no early exit. The version prefix leaves room for a scheme change.
  - **Order:** `/health` is open; for everything else the body is read (≤ 16 KiB, a declared larger `content-length` refused unread, a chunked one counted as it streams) and the signature checked **before** JSON parsing or routing, so an unsigned caller gets `401` everywhere and learns no paths. Refusal reasons (`MISSING_SIGNATURE`, `BAD_TIMESTAMP`, `STALE_TIMESTAMP`, `BAD_SIGNATURE`) are returned: they reveal nothing secret and make clock skew debuggable.
  - **Rotation:** the worker accepts `ENQUEUE_HMAC_SECRET` and, during a rollover, `ENQUEUE_HMAC_SECRET_PREVIOUS` (each ≥ 32 characters; the worker refuses to start otherwise, naming the variable, never the value). Rollover: put the new secret in the worker as current and the old one as previous, restart; change Vercel's value and redeploy; remove previous.
  - **Job IDs are derived, not given:** `<kind>-<first 32 hex of SHA-256>` over kind, lowercased owner and repo, SHA, base SHA, and the analyzer version. One commit is one job however often it's asked for (T9 dedupe), a new analyzer version re-analyzes, and an ID can't be enumerated. `installationId` is left out: it changes who may fetch the commit, not the analysis. `202 { id, created }`; `created: false` means the job already exists.
  - **Validation by hand** like `protocol.ts` (no zod in the worker): GitHub's owner/repo rules (the same as `apps/web/lib/repoUrl.ts`), 40 lowercase hex SHAs, `baseSha` iff `diff`, positive integer `installationId`, unknown keys refused; error messages name a field, never echo its value.
  - **The queue is an interface** (`JobQueue`: `add`, `get`, `ping`); M5.4d backs it with BullMQ. `GET /jobs/:id` copies only the documented status fields. A failing queue is `503 QUEUE_UNAVAILABLE`; `/health` waits 2 s for `ping` and says only `ok`/`unavailable`.
  - **The signer is importable on its own** (`@gitinside/worker/hmac`, only `node:crypto`), so M5.6's `/api/analyze` signs with exactly the code the worker verifies.
- **Alternatives rejected:** Express or Fastify (dependencies for three routes); signing the body only (signatures replayable across paths, and GETs have no body); a nonce store against replays inside the window (a replayed enqueue is the same derived ID, so it's a no-op, and a replayed GET reads a status the caller already saw); mTLS (Caddy and Vercel's fetch would both need client-cert plumbing); random job IDs from the caller (no dedupe without another lookup).
- **Consequences:** the web app and VM clocks must agree within 5 minutes (both use NTP). Caddy must pass the request target unchanged, or signatures fail. SECURITY.md T8 now describes the method + path binding.

## ADR-0061: The BullMQ worker: one pipeline function, coded failures that say whether to retry, Redis tests on CI only
- **Context:** M5.4d ties M5.4a–c together: take a job from Redis, fetch the commit's tarball from GitHub, extract it, run the sandboxed child, hand the graph on, and delete the job folder. ADR-0014 fixed BullMQ, `attempts: 3` with backoff, concurrency 2; DESIGN.md §12 says a worker crash re-queues the job (max 3 attempts). BullMQ 6 (current since July 2026) no longer bundles ioredis, and Docker doesn't run on the development machine, so there's no local Redis.
- **Decision:**
  - **`processJob(context, deps)`** (`apps/worker/src/job.ts`) is the whole pipeline and knows nothing about BullMQ: download and extract (one 2-minute budget; the tarball streams from `fetch` into `extractTarball`, never buffered on disk), run (runner.ts's own 5 minutes), `publish` (injected; M5.5 writes R2 + Postgres), then `rm` the folder in `finally`. Folders are `<jobsRoot>/<id>-<random>`, so a stalled attempt still running somewhere never shares one with its retry; `sweepJobsRoot` clears leftovers at startup (a SIGKILL skips `finally`). Stages `download → extract → analyze → upload` are reported as BullMQ progress.
  - **Failures are `JobFailure { code, retriable, detail }`** (`failure.ts`). The message is only the code, so that is all BullMQ stores (`failedReason`, shown as `errorCode`); `detail` (stderr tails, hosts) goes to logs. Retriable: `DOWNLOAD_FAILED` (network, 408, 5xx), `DOWNLOAD_TIMEOUT`, `GITHUB_RATE_LIMITED`, `CANCELLED`, `PUBLISH_FAILED`, `WORKER_ERROR` (anything unexpected). Everything else (`REPO_NOT_FOUND`, `TAR_*`, `LIMIT_*`, `ANALYZER_CRASHED`, …) is thrown as BullMQ's `UnrecoverableError`, so a deterministic failure costs one run, not three.
  - **Downloads** (`github.ts`) follow redirects by hand: inside the API (a renamed repo) with the token, at most 3 hops; to `https://codeload.github.com` **without** the token; anywhere else refused unfetched (`DOWNLOAD_REFUSED`). 404 ⇒ `REPO_NOT_FOUND`, 451 ⇒ `REPO_UNAVAILABLE`, 403/429 with a rate-limit header ⇒ `GITHUB_RATE_LIMITED`.
  - **Queue** (`queue.ts`): one queue `analysis`; job options `attempts: 3`, exponential backoff from 15 s, finished jobs kept 24 h for status lookups. Worker: concurrency 2, `maxStalledCount: 2` (with the first run, at most 3 starts; past that `JOB_STALLED`), default 30 s locks (the analysis runs in a child, so the event loop is free to renew them). Adding an existing ID is a no-op, except a job that **failed retriably** (GitHub down for all 3 attempts), which is retried with its counters reset; otherwise a transient outage would block that commit for a day. Waiting jobs get their position from the wait list, oldest first. API calls into the queue time out after 5 s (`503`) instead of waiting on a dead Redis. `stopWorker` aborts running jobs through BullMQ's processor signal (they fail `CANCELLED` and run again after the restart).
  - **Stored data is validated again** with `parseJobRequest` before a job runs, and the job ID must be a plain folder name.
  - **Dependencies:** `bullmq` 6.4.2 and `ioredis` 5.11.1 (BullMQ 6's default client, now an optional peer), exact pins; not the newest BullMQ (released the same day).
  - **Tests:** the pipeline against a fake GitHub (two local HTTP servers; the real child on a fixture tarball, every failure path, folder cleanup) and the processor's error mapping run everywhere. BullMQ itself (dedupe, positions, stages, permanent vs. retried failures, re-adding a retriably failed job, concurrency 2, stalled-job recovery by a second worker, cancel on shutdown, the signed API end to end) runs only with `TEST_REDIS_URL`: CI's `redis:7.4-alpine` service. A guard test fails on CI if the variable is missing, and `turbo.json` now passes `CI`, `TEST_DATABASE_URL`, and `TEST_REDIS_URL` through to tasks (Turbo 2's strict env mode filters unlisted variables).
- **Alternatives rejected:** BullMQ's Postgres backend (new in 6; ADR-0014 chose Redis, and Neon's free compute would pay for the polling); `ioredis-mock` (no Lua, which BullMQ runs everywhere); following redirects with `fetch`'s default (it would send the token to whatever host the redirect names); retrying every failure (a repo over 20k files would run three times); buffering the tarball to disk first (twice the disk, and no earlier failure).
- **Consequences:** the worker's entry point (env ⇒ Redis, `jobsRoot`, sweep, worker + enqueue server, JSON logs, SIGTERM ⇒ `stopWorker`) arrives with M5.5, when `publish` has somewhere to put the graph. Diff jobs fail `UNSUPPORTED_JOB` until M6. Unauthenticated tarball downloads share GitHub's 60/hour per-IP limit until a token is configured (M8's app token). The BullMQ tests' coverage counts only on CI.

## ADR-0062: Snapshot store: our own SigV4 signer, keys per analyzer version, gzip level 9
- **Context:** M5.5a. The worker must put each finished graph in R2 (ADR-0013) before M5.5b records it in Postgres. R2 speaks S3's API, authenticated with AWS Signature Version 4. ADR-0013's keys (`…/<sha>.json.gz`) have no analyzer version, but `analyses` is unique per (repo, sha, analyzer version), and public snapshots are meant to be cached by a CDN.
- **Decision:**
  - **Our own SigV4** (`apps/worker/src/sigv4.ts`, ~100 lines on `node:crypto`): canonical request, string to sign, derived key, `Authorization` header. Tested against the three worked examples in AWS's documentation (IAM `ListUsers`, S3 GET Object, S3 PUT Object with a `$` in the key); all three matched on the first run. Each path segment is percent-encoded once (S3 doesn't double-encode); a header given twice in different case is refused.
  - **Store** (`storage.ts`): `createObjectStore(config).put(key, body, headers)`, path-style `<endpoint>/<bucket>/<key>`, region `auto`. The body's SHA-256 is signed as `x-amz-content-sha256`, so a body changed in transit is refused by R2. `Host` is signed as `url.host` and left for `fetch` to send. 60 s per request. Failures are `StorageError { status?, s3Code? }`: only S3's `<Code>` is kept from an error body, and no message carries credentials (the job turns it into the retriable `PUBLISH_FAILED`).
  - **Keys** (amends ADR-0013): `public/<owner>/<repo>/<sha>/<analyzerVersion>.json.gz` with owner and repo lowercased (GitHub ignores case, like `jobIdFor`), and `private/<installationId>/<repoId>/<sha>/<analyzerVersion>.json.gz`. Every part is validated before it becomes a key, and the store refuses any key with empty, `.`, or `..` segments or characters outside `[A-Za-z0-9._/-]`. One object per `analyses` row, so a new analyzer version never overwrites an object a cache may still hold, and retention (M5.12) deletes exactly the rows it evicts.
  - **Objects:** `architecture.json` gzipped at level 9 (async, as the enqueue API shares the event loop), `Content-Type: application/json`, `Content-Encoding: gzip`; public `Cache-Control: public, max-age=31536000, immutable` (a key's content never changes), private `private, no-store` (SECURITY.md T6).
  - **Config:** `storeConfigFromEnv` reads `R2_ACCOUNT_ID` (32 lowercase hex, which also stops it from redirecting the endpoint), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (ADR-0055); errors name the variable, never its value.
  - **Tests:** a fake S3 server (`s3.testkit.ts`) recomputes each signature from the headers the request says it signed and checks the body hash, as R2 does; wrong secret, tampered body, non-XML errors, no response, timeout, and unsafe keys are each tested.
- **Alternatives rejected:** `@aws-sdk/client-s3` (dozens of transitive packages for one PUT, SECURITY.md T12); `aws4fetch` (small, but a dependency for code we can test against AWS's own examples); presigned URLs (the worker holds the key anyway); the unversioned ADR-0013 key (a re-analysis by a newer analyzer would overwrite an "immutable" object); gzip level 6 (graphs are text, and storage, not CPU, is the scarce free quota).
- **Consequences:** no GET/DELETE yet: M5.12 (retention), M5.8 (serving), and M8.5 (uninstall) add them on the same signer. The worker's egress allowlist (M5.10) needs `<account>.r2.cloudflarestorage.com`.

## ADR-0063: Postgres writes: the worker records each attempt, GitHub supplies the repo facts, `publish` = R2 then Postgres
- **Context:** M5.5b. The worker must leave a `repos` row and an `analyses` row (DESIGN.md §10) whose status follows the job. A repo row needs GitHub's ID, current name, visibility, and default branch, none of which the enqueue request carries. The schema enforces the status ⇔ columns rule, and `repos` has two unique keys (GitHub's ID, and owner/name ignoring case).
- **Decision:**
  - **Lifecycle functions live in `@gitinside/db`** (`analyses.ts`), shared with the web app (M5.6): `upsertRepo`, `startAnalysis` (insert or restart as `running`), `requeueAnalysis` (`running` ⇒ `queued`), `completeAnalysis`, `failAnalysis`, `failInterruptedAnalyses`. Times come from the database's `now()`. **A `done` row is never changed again** (`startAnalysis` returns it as is, `failAnalysis`/`requeueAnalysis` skip it), so a redundant job can't hide a cached result; `completeAnalysis` accepts any other status, since the snapshot now exists.
  - **Repo facts come from GitHub at the start of each attempt** (`fetchRepoFacts`, `GET /repos/{owner}/{repo}`, API-only redirects with the token, the answer validated field by field). **A private repo on a job without an installation fails `REPO_NOT_PUBLIC`** before anything is downloaded or written: the worker's token may be able to read it, but it must never reach the public cache (SECURITY.md T6). GitHub's spelling (after a rename or a case change) names the row and the public snapshot key.
  - **A stale holder of a name** (a repo renamed or deleted on GitHub, whose name a new repo took) is renamed `~<its GitHub ID>` inside the upsert's transaction instead of deleted, so its analyses survive until it is seen again; no GitHub name contains `~`.
  - **`processJob` gets an optional `JobRecorder`** (`start` before the download, inside the download budget; `failed(record, code, final)` after a failed attempt). `final` = the failure isn't retriable, or the processor says it's the last attempt (`attemptsMade + 1 >= opts.attempts`); a non-`JobFailure` counts as the processor's retriable `WORKER_ERROR`. If recording a failure fails too, it's logged (`record_failed`) and the job's own failure is what the queue sees. A failing start is the retriable `RECORD_FAILED`.
  - **`publish` = R2, then Postgres** (`createAnalysisRecorder(...).publish`): upload the gzipped snapshot under the public or private key, then `completeAnalysis` with stats (files, nodes, edges, unresolved, warnings, graph and stored sizes, analyzer stage times, and worker `jobMs` for download, analyze, upload). A `done` row therefore always has its object; if the database write fails, the retry uploads the same immutable key again.
  - **`files`** joins the child's stats (the graph's `file` nodes), as DESIGN.md §10 lists it.
  - **Tests:** the lifecycle on PGlite (or CI's Postgres) in `packages/db`; the worker's recorder end to end through `processJob` with a migrated database, the fake S3, and the fake GitHub. The db package's test database helper is now a built entry, `@gitinside/db/testing`.
- **Alternatives rejected:** the web app writing the repo row and passing its facts in the job (the enqueue API would grow fields, and the worker would trust a visibility it can check itself); deleting a stale name holder (loses analyses of a renamed repo); marking `failed` on every failed attempt (the progress page would flash "failed" before a retry succeeds); writing Postgres before R2 (a `done` row could point at a missing object).
- **Consequences:** one extra GitHub API call per attempt (inside the same rate limit as the tarball). A job that stalls out (`JOB_STALLED`, no processor runs) leaves its row `running`; the entry point (M5.5d) calls `failInterruptedAnalyses` with its own start time after the sweep. `installations` rows and `repos.installation_id` are linked by M8.3. Concurrent jobs for a rename-swapped pair of repos could deadlock the two upserts; Postgres aborts one and it's retried.
