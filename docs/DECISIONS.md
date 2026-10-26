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
