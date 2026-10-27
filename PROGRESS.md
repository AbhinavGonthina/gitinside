STATUS: RUNNING
AUTONOMY: ON

# Progress

The single source of truth for what to do next. Mirrors [docs/ROADMAP.md](docs/ROADMAP.md).

**Rules**
- Lines 1–2 are read by `scripts/autopilot.ps1`. Keep the exact formats: `STATUS: RUNNING | BLOCKED <reason> | DONE` and `AUTONOMY: ON | OFF`.
- Work on the **first unchecked task that isn't blocked**. Don't skip ahead otherwise.
- Task line format: `- [ ] M<n>.<k> <title> {model: opus}`. The script reads the model tag of that same first unblocked task. Untagged tasks default to opus. **All tasks use Opus** (Abhinav's decision 2026-10-26, D12.1): tag new or split tasks `{model: opus}` too.
- Blocked tasks get ` {blocked: <reason or issue #>}` appended and are skipped until unblocked. Remove the tag when resolved.
- If a task is too big for one commit, split it into `M<n>.<k>a`, `M<n>.<k>b`, … before starting.
- After finishing a task: check it, add a 2–4 line note under **Session notes** (newest first), commit, push.

## Current task
M2.7. docker-compose + .env detectors (names/schemes only) + stores edges

## Needs Abhinav
(Mirrors open `needs-abhinav` issues in gitinside-planning. Autopilot keeps working on other tasks.)
- none yet

## Blockers
- none

## Milestones

### M1: Analyzer CLI
- [x] M1.1 Repo tooling: ESLint (typescript-eslint strict) + Prettier + root lint script + GitHub Actions CI (lint, typecheck, test, coverage) {model: opus}
- [x] M1.2 packages/analyzer scaffold: library API `analyze(dir)`, CLI `gitinside analyze <path> [--out]` {model: opus}
- [x] M1.3 Inventory: deterministic walk, ignore rules, generated-file detection, 20k limit, 2 MB skip warnings {model: opus}
- [x] M1.4 Workspace detection (npm/yarn/pnpm/Turborepo/Nx/Lerna) → service nodes; single-package fallback {model: opus}
- [x] M1.5 Per-service TS program: tsconfig loading, synthesized defaults, paths/baseUrl, no node_modules, warnings {model: opus}
- [x] M1.6 Module and file nodes with content hashes {model: opus}
- [x] M1.7 Symbol extraction (functions, classes, methods, exported consts) {model: opus}
- [x] M1.8 Import edges incl. cross-workspace package imports {model: opus}
- [x] M1.9 Call edges for locally resolved calls {model: opus}
- [x] M1.10 Express route detector (methods, router.route, mount composition, nested/imported routers, handles edges) {model: opus}
- [x] M1.11 Next.js detector (app router route.ts, pages/api, pages, dynamic segments, route groups) {model: opus}
- [x] M1.12 Prisma detector (schema models/fields/datasource, client reads/writes, $queryRaw unresolved) {model: opus}
- [x] M1.13 Graph assembly + canonical serialization + validation before write {model: opus}
- [x] M1.14 Fixtures (express-basic, express-nested-routers, next-app-router, next-pages-api, prisma-relations, pnpm-monorepo, syntax-error, no-tsconfig) + golden tests {model: opus}
- [x] M1.15 Determinism test + analyzer coverage ≥ 85% + analysis benchmark baseline {model: opus}
- [x] M1.16 Milestone verification + docs/milestones/M1-review.md + tag m1 {model: opus}

### M2: Cross-service links + infra
- [x] M2.1 HTTP call-site collection (fetch, axios.*, axios(config), axios.create instances via imports) {model: opus}
- [x] M2.2 URL expression normalizer (literals, templates, concat, imported consts, env bases, new URL) {model: opus}
- [x] M2.3 One-level wrapper inlining; WRAPPER_DEPTH beyond {model: opus}
- [x] M2.4 Route matcher with confidence scoring, ambiguity, route index {model: opus}
- [x] M2.5 Unresolved nodes/edges with reasons; literal external hosts → external nodes {model: opus}
- [x] M2.6 External SDK detector (allowlist) → external_call edges {model: opus}
- [ ] M2.7 docker-compose + .env detectors (names/schemes only) + stores edges {model: opus}
- [ ] M2.8 BullMQ/queue client detection → publishes/consumes {model: opus}
- [ ] M2.9 Pattern fixtures + golden tests + "no call site dropped" test + secret-leak test {model: opus}
- [ ] M2.10 docs/walkthroughs/resolver.md (line-by-line, diagrams, explain-it-back checklist) {model: opus}
- [ ] M2.11 Milestone verification + M2-review.md + tag m2 {model: opus}

### M3: Accuracy eval harness
- [ ] M3.1 eval/ package scaffold + ground-truth format per docs/EVALUATION.md {model: opus}
- [ ] M3.2 Select 5 repos, pin SHAs in eval/repos.json {model: opus}
- [ ] M3.3 Draft labels for repos 1–2 (independently of analyzer output; commit before scoring) {model: opus}
- [ ] M3.4 Draft labels for repos 3–5 {model: opus}
- [ ] M3.5 Scoring script (overall / per repo / per confidence, FP and FN lists) {model: opus}
- [ ] M3.6 Report generator → eval/results/ ("Pending owner review") + pnpm eval reproducibility {model: opus}
- [ ] M3.7 Open needs-abhinav issue: review a seeded random 20% of labels {model: opus}
- [ ] M3.8 Milestone verification + M3-review.md + tag m3 {model: opus}

### M4a: Design system + prototype (design gate)
- [ ] M4a.1 packages/viewer scaffold (React, Vite lib, Storybook) {model: opus}
- [ ] M4a.2 Tokens (dark default + light), self-hosted Geist fonts {model: opus}
- [ ] M4a.3 Icon system: Simple Icons brand mapping + custom glyph set for kinds {model: opus}
- [ ] M4a.4 Node components per kind, all states {model: opus}
- [ ] M4a.5 Edge components (confidence styles, labels, flow, broken, arrows) {model: opus}
- [ ] M4a.6 Chrome components (top bar, inspector, breadcrumbs, minimap shell, legend, palette shell) {model: opus}
- [ ] M4a.7 Static clickable prototype on a fixture graph {model: opus}
- [ ] M4a.8 Visual regression baseline (stories, light + dark, Linux CI) {model: opus}
- [ ] M4a.9 M4a-review.md with screenshots + needs-abhinav design-approval issue; UI work then waits for approval {model: opus}

### M4b: Interactive explorer
- [ ] M4b.1 Viewer graph model: hierarchy index, edge aggregation, visibility {model: opus}
- [ ] M4b.2 ELK layout in a Web Worker with stable ordering + layout cache {model: opus}
- [ ] M4b.3 Semantic drill-down with animated in-place transitions + reduced motion {model: opus}
- [ ] M4b.4 Breadcrumbs, minimap, pan/zoom/fit {model: opus}
- [ ] M4b.5 Inspector (summary template, facts, connections, Shiki preview, Open on GitHub) {model: opus}
- [ ] M4b.6 Trace mode (path BFS, dimming, pulse, step player, cross-level behavior) {model: opus}
- [ ] M4b.7 Ctrl+K command palette {model: opus}
- [ ] M4b.8 Filters {model: opus}
- [ ] M4b.9 Deep links {model: opus}
- [ ] M4b.10 Export SVG / PNG / Mermaid {model: opus}
- [ ] M4b.11 Keyboard navigation + screen-reader announcements {model: opus}
- [ ] M4b.12 Onboarding hints + empty/error states {model: opus}
- [ ] M4b.13 Viewport culling + bench/render fps at 2,000 nodes {model: opus}
- [ ] M4b.14 Playwright E2E + visual tests {model: opus}
- [ ] M4b.15 Milestone verification + M4b-review.md + tag m4 {model: opus}

### M5: Website (public) + live badge
- [ ] M5.1 Open needs-abhinav signup issues (Oracle VM, Neon, R2, Vercel, DNS CNAME) with step-by-step instructions {model: opus}
- [ ] M5.2 apps/web Next.js scaffold, landing page, viewer integration {model: opus}
- [ ] M5.3 Drizzle schema + migrations (local Postgres in Docker for dev/CI) {model: opus}
- [ ] M5.4 apps/worker: BullMQ worker + HMAC enqueue API + safe tarball extraction + child-process limits {model: opus}
- [ ] M5.5 Worker: R2 upload, Postgres writes, progress events {model: opus}
- [ ] M5.6 /api/analyze: URL parsing, latest SHA, cache, rate limits, dedupe {model: opus}
- [ ] M5.7 Progress page with real stages + queue position (SSE) {model: opus}
- [ ] M5.8 Diagram page + check-on-view re-analysis {model: opus}
- [ ] M5.9 Badge + live image endpoint + "Add to README" {model: opus}
- [ ] M5.10 Hardened worker Docker image + infra/oracle provisioning script + docs {model: opus}
- [ ] M5.11 Security test suite with malicious fixtures {model: opus}
- [ ] M5.12 Snapshot retention + quota check {model: opus}
- [ ] M5.13 Deploy + production smoke test on a real public repo {model: opus}
- [ ] M5.14 Milestone verification + M5-review.md + tag m5 {model: opus}

### M6: Graph diff + incremental analysis
- [ ] M6.1 packages/diff scaffold + GraphDiff types in schema {model: opus}
- [ ] M6.2 Node/edge classification with per-kind fingerprints {model: opus}
- [ ] M6.3 Rename/move detection with tuned thresholds {model: opus}
- [ ] M6.4 Broken-edge detection incl. head re-resolution {model: opus}
- [ ] M6.5 Property tests (fast-check) {model: opus}
- [ ] M6.6 gitinside diff CLI (paths or git refs) + Mermaid summary {model: opus}
- [ ] M6.7 Incremental cache (content-hash facts, importer invalidation, disk LRU) {model: opus}
- [ ] M6.8 Benchmarks: full vs incremental on a large TS monorepo {model: opus}
- [ ] M6.9 Viewer diff mode (overlay, stable layout, changes list) {model: opus}
- [ ] M6.10 docs/walkthroughs/diff.md {model: opus}
- [ ] M6.11 Milestone verification + M6-review.md + tag m6 {model: opus}

### M7: PR backtesting
- [ ] M7.1 Select ~8 repos + pin window in eval/backtest/repos.json {model: opus}
- [ ] M7.2 Replay script (merged PRs, incremental analyze, diff, collect broken edges) {model: opus}
- [ ] M7.3 Follow-up fix detection {model: opus}
- [ ] M7.4 Classification of flagged breaks (drafted, labeled as such) {model: opus}
- [ ] M7.5 Report → eval/backtest/results/ {model: opus}
- [ ] M7.6 Milestone verification + M7-review.md + tag m7 {model: opus}

### M8: Sign-in + private repos + PR bot
- [ ] M8.1 needs-abhinav: register GitHub App (permissions per ADR-0009) + secrets {model: opus}
- [ ] M8.2 GitHub sign-in (identity only), sessions, dashboard {model: opus}
- [ ] M8.3 Install flow + installation webhooks + private snapshot prefix {model: opus}
- [ ] M8.4 Per-view access checks (60s cache), private isolation, noindex {model: opus}
- [ ] M8.5 Uninstall → immediate deletion (tested) {model: opus}
- [ ] M8.6 PR webhook → diff job → comment + Check Run (updated in place) {model: opus}
- [ ] M8.7 Push webhook → badge refresh {model: opus}
- [ ] M8.8 Security tests (signatures, revocation, cross-tenant isolation) {model: opus}
- [ ] M8.9 Switch autopilot to PR flow reviewed by GitInside's bot; update CLAUDE.md {model: opus}
- [ ] M8.10 Milestone verification + M8-review.md + tag m8 {model: opus}

### M9: Launch-ready (no public announcement)
- [ ] M9.1 Choose + hand-verify 3 OSS demo repos; landing gallery {model: opus}
- [ ] M9.2 Final eval + benchmarks; README numbers with links {model: opus}
- [ ] M9.3 README (slogan, GIF with trace first, quickstart, architecture, results) {model: opus}
- [ ] M9.4 Docs pages (how it works, limits, privacy) + root SECURITY.md {model: opus}
- [ ] M9.5 Blog post draft + needs-abhinav edit/publish-decision issue {model: opus}
- [ ] M9.6 Full regression + axe accessibility audit {model: opus}
- [ ] M9.7 Milestone verification + M9-review.md + tag m9; set STATUS: DONE {model: opus}

## Session notes
(Newest first. 2–4 lines per task.)

- 2026-10-27 · M2.6: `buildSdkEdges` in `packages/analyzer/src/sdk.ts` (new `sdk` stage) traces clients of allowlisted SDKs (Stripe, OpenAI, Anthropic, Resend, Twilio, SendGrid, HubSpot, Slack, Octokit, Postmark, Mailgun, `googleapis`/`@googleapis/*`, every `@aws-sdk/client-*`) like axios instances, and turns method calls on them into unlabeled `external_call` edges to the API host's node, shared with `fetch` via `externalNode()` (ADR-0035). Client-building calls and listed local helpers aren't requests. 434 analyzer tests, sdk.ts 94.1% lines; goldens unchanged; cal.com: `external_call` 79 → 138 (Stripe 23, Google 21, HubSpot 15, SendGrid 1), 29 hosts, no duplicate nodes. Also fixed an M2.5 Prettier slip that broke `pnpm lint`. Next: M2.7.

- 2026-10-27 · M2.5: `buildHttpEdges` now returns nodes too. Unmatched requests get an `unresolved` node at the site (wrapper call when inlined) with reason, source `expression`, and a new optional schema field `detail`, plus an `unresolved` `http` edge; literal hosts get `external:ext/<host>` + `external_call` (exact). Credentials are stripped from hosts in `toUrlPattern`, default ports in `externalHost()` (ADR-0034). 416 analyzer + 15 schema tests, match.ts 97.3% lines; goldens unchanged; cal.com: all 269 requests in the graph (38 route, 135 unresolved, 79 external_call to 26 hosts). Next: M2.6.

- 2026-10-27 · M2.4: `createRouteMatcher`/`buildHttpEdges` in `packages/analyzer/src/match.ts`, wired in as the new `http` stage. Base, method, and path levels combine and the weakest wins (root-relative is exact in the caller's own service, heuristic across services; API-named env bases, loopback hosts, and unknown methods are heuristic). Ties break on path level, then specific method over `ALL`; remaining ties are `AMBIGUOUS`, one level weaker but never below heuristic. DP path alignment; index by method + first literal segment (ADR-0033). 403 analyzer tests, match.ts 96.6% lines; goldens unchanged; cal.com: 38 edges from 41 sites (22 exact / 7 pattern / 9 heuristic), stage 3.8 s. Unmatched requests get no edge until M2.5. Next: M2.5.

- 2026-10-27 · M2.3: `inlineWrappers` in `packages/analyzer/src/wrappers.ts` turns call sites into `HttpRequest`s: a site whose URL/`baseURL`/method reads a parameter of its symbol is a wrapper body, and each resolved call to that symbol becomes its own request with the parameters bound (normalizer `bindings`); a URL still starting with the caller's parameter is `WRAPPER_DEPTH`; uncalled wrappers keep their site (ADR-0032). `methodSource` lets `{ method: "GET", ...init }` resolve per caller. 349 analyzer tests, wrappers.ts 90.7% lines; cal.com: 217 sites ⇒ 269 requests, 0 dropped, 157 resolved (was 130), 1.3 s. Next: M2.4.

- 2026-10-27 · M2.2: `createUrlNormalizer` in `packages/analyzer/src/url.ts`: `parts()` evaluates URL expressions (literals, templates, `+`, consts via imports/workspace packages, const objects, enums, literal types, `process.env`/`import.meta.env`, `location.origin`, `new URL`) to text/hole/env parts; pure `toUrlPattern()` yields base (`path`/`page`/`host`/`env`) + segments, queries dropped; a leading hole is `DYNAMIC_URL` with a detail (ADR-0031). Value readers moved to `values.ts`. fast-check idempotence property added. 340 analyzer tests, url.ts 98.7% lines; cal.com: 130/217 resolve, 87 `DYNAMIC_URL`, 69 ms. Next: M2.3.

- 2026-10-27 · M2.1: `collectHttpCalls` in `packages/analyzer/src/http.ts` returns one sorted `HttpCallSite` per `fetch`/axios request (method, URL and `baseURL` expressions with their program, owners, confidence); axios instances traced like the Prisma client, incl. workspace packages. `null` = set but unreadable, never defaulted (ADR-0030). Not wired into the graph yet (M2.4/M2.5), so goldens are unchanged. 280 analyzer tests, http.ts 92% lines; cal.com smoke: 217 sites in 2.7 s warm. Next: M2.2.

- 2026-10-27 · M1.16: milestone verified and tagged `m1`. The fresh-eyes review found 7 issues plus 4 minor ones, all fixed with tests in 6 commits: glob ReDoS → DP matcher; brace-expansion and Express mount blowups → caps with warnings; pages API fall-through methods now add `ALL`; only manifest names resolve imports; the CLI repo name no longer comes from the folder (`--owner/--name/--sha` added); `FILES_OUTSIDE_SERVICE` and `PRISMA_NO_DATASOURCE` warnings. 293 tests, analyzer 98.18%. cal.com smoke test passes; 108 `AMBIGUOUS` Prisma calls from a second example schema are logged for the M3 eval. Review: `docs/milestones/M1-review.md`. Next: M2.1.

- 2026-10-26 · Model policy: every task now uses Opus (was 69 Opus / 38 Sonnet). Abhinav prefers maximum quality over speed, and his plan has no weekly cap, only the 5-hour session window. Not a task; next is still M1.16.

- 2026-10-26 · M1.15: `determinism.test.ts` analyzes every fixture twice plus once from a copy at another path (space + non-ASCII) and byte-compares; analyzer line coverage 98.15% (threshold 85). `analyze()` gained `onStage(stage, ms)`; new `bench/` package (`pnpm bench`) shallow-fetches pinned repos and runs 1 warm-up + 5 fresh-process runs. Baseline `bench/results/2026-10-26-analysis-calcom.md`: cal.com (5,041 files), median 53.3 s (27–77 s, noisy dev machine), ~2 GiB RSS, graphs identical. Analyzer `testTimeout` 30 s (first-test TS lib parse exceeded 5 s under parallel coverage). Next: M1.16.

- 2026-10-26 · M1.14: eight fixtures under `fixtures/<name>/` (README + `expected.json` golden each) and `packages/analyzer/src/fixtures.test.ts`: byte-compares `serializeGraph` output to the golden (`UPDATE_GOLDEN=1` regenerates) plus per-fixture semantic assertions so a regenerated golden can't hide a regression. `.gitattributes` pins `fixtures/**` to LF because goldens embed file hashes. 225 analyzer tests; lint/typecheck green. Next: M1.15.

- 2026-10-26 · M1.13: `assembleGraph`/`serializeGraph` in `packages/analyzer/src/assemble.ts`: passes are ordered `GraphPart`s (order = precedence); differing duplicate nodes keep the first with a `DUPLICATE_NODE` warning, duplicate edges merge sites/fields and keep the strongest confidence, schema failures throw `INVALID_GRAPH` with readable issues; `serializeGraph` re-validates the stringified text and the CLI writes `--out` via temp file + rename (ADR-0029). 209 analyzer tests, 98.1% coverage; lint/typecheck/build green; CLI on this repo: 198 nodes, 273 edges. Next: M1.14.

- 2026-10-26 · M1.12: `buildPrisma` in `packages/analyzer/src/prisma.ts`: line-based `.prisma` parser (models, views, fields, datasource, multi-file), `model` nodes under their schema file, `datastore:infra/<svc>/<file>#<ds>` + `stores` edges; client calls traced with the checker to `new PrismaClient()`/typed clients (`exact`) or `db`/`tx`/`*prisma*` names (`heuristic`) ⇒ `reads`/`writes` with new optional edge `fields`; `RAW_QUERY`/`AMBIGUOUS`/`UNKNOWN_SYMBOL` unresolved nodes; inline Express handlers attribute to the route (ADR-0028). 196 analyzer tests, 98.1% coverage; lint/typecheck/build green; CLI smoke-tested on a scratch Express+Prisma app. Next: M1.13.

- 2026-10-26 · M1.11: `buildNextRoutes` in `packages/analyzer/src/next.ts`, for services depending on `next`: app router `route.ts` method exports (read via `getExportsOfModule`, so re-exports and `export const { GET, POST }` count) and `page.tsx`, pages router pages and `pages/api` (ALL unless `req.method` checks are visible); `[id]`/`[...x]`/groups/slots/private folders/`src/` fallback; `handles` + `renders` edges; `NEXT_ROUTE_NO_METHODS`/`NEXT_DUPLICATE_ROUTE` warnings (ADR-0027). 167 analyzer tests, 99.1% coverage; lint/typecheck/build green; CLI smoke-tested on a scratch Next app. Next: M1.12.

- 2026-10-26 · M1.10: `buildExpressRoutes` in `packages/analyzer/src/express.ts`: router objects created by `express()`/`Router()` (or typed params), followed with the checker across files/CommonJS/factories/class props and into functions they're passed to; `use` mounts composed into full paths; `route` nodes keyed by the root app's service, `handles` edges via the shared `createSymbolResolver`; dynamic paths → `DYNAMIC_ROUTE` unresolved nodes, unmounted routers → `EXPRESS_UNMOUNTED_ROUTER` warning (ADR-0026). 136 analyzer tests, 99.0% coverage; lint/typecheck/build green; CLI on this repo unchanged in kind (no Express). Next: M1.11.

- 2026-10-26 · M1.9: `buildCallEdges` in `packages/analyzer/src/calls.ts`: symbol → symbol `calls` edges, caller = innermost enclosing symbol, callee via each service's type checker (aliases, re-exports, object properties, overloads, `new C()`); workspace package imports bridged with the M1.8 resolver (now `createModuleResolver`), taking the import's confidence; unresolved callees get no edge (ADR-0025). 119 analyzer tests, 98.7% coverage; lint/typecheck/build green; CLI on this repo emits 98 call edges, 16 cross-service. Next: M1.10.

- 2026-10-26 · M1.8: `extractImports`/`buildImportGraph` in `packages/analyzer/src/imports.ts`: file → file `imports` edges from import/export-from, `import = require`, literal `require()`/`import()`; TS resolution first, then workspace packages via their `package.json` (`src/index` fallbacks are `heuristic`); unresolvable local specifiers become `unresolved` nodes (ADR-0024). 111 analyzer tests, 98.9% coverage; lint/typecheck/build green; CLI on this repo emits 51 import edges incl. `@gitinside/schema` → `schema/src/index.ts`. Next: M1.9.

- 2026-10-26 · M1.7: `extractSymbols`/`buildSymbolNodes` in `packages/analyzer/src/symbols.ts`: top-level functions, classes + methods (`Class.method`, parented to the class), function-valued consts, and exported values; exports detected syntactically incl. CommonJS (ADR-0023). 97 analyzer tests, 98.9% coverage; lint/typecheck/build green; CLI on this repo emits 86 symbols. Next: M1.8.

- 2026-10-26 · M1.6: `buildFileNodes` in `packages/analyzer/src/files.ts`: module nodes for folders that directly hold source files (nested under nearest ancestor module, else service), file nodes with SHA-256 of raw bytes; IDs service-relative, `path` repo-relative; files outside every package skipped. 86 analyzer tests; lint/typecheck green. Next: M1.7.

- 2026-10-26 · M1.5: `buildServicePrograms` in `packages/analyzer/src/program.ts`: one `ts.Program` per service over an inventory-only compiler host (plus TS's bundled libs); tsconfig/jsconfig with in-repo `extends`, `paths`, `baseUrl`; synthesized defaults; forced safe options; `TSCONFIG_MISSING`/`TSCONFIG_INVALID`/`SYNTAX_ERROR` warnings with machine paths stripped (ADR-0022). 82 analyzer tests, 98.4% coverage; lint/typecheck/build green; CLI on this repo adds no new warnings. Next: M1.6.

- 2026-10-26 · M1.4: `detectWorkspace` in `packages/analyzer/src/workspace.ts`: npm/yarn `workspaces`, `pnpm-workspace.yaml` (with `!` excludes, via `yaml`), `lerna.json`, Nx `project.json`, `turbo.json`; root-service fallback; folder-name service keys with deterministic disambiguation (ADR-0021); warnings for bad config, unmatched patterns, duplicate names, dependency cycles. 60 analyzer tests, 98.4% coverage; lint/typecheck/build green; CLI on this repo finds `analyzer` + `schema`. Next: M1.5.

- 2026-10-26 · M1.3: `buildInventory` in `packages/analyzer/src/inventory.ts`: sorted full-path walk, fixed ignore-dir list, symlinks never followed, generated/2 MB/depth-64 skips as graph warnings, `LIMIT_FILES` `AnalysisError` over 20k source files (ADR-0020). 28 analyzer tests, 97.8% coverage; lint/typecheck/build green; CLI smoke-tested on this repo. Next: M1.4.

- 2026-10-26 · M1.2: `packages/analyzer` scaffold: `analyze(dir, opts)` returns a schema-validated graph (system root only for now) and `gitinside analyze <path> [--out]` CLI with injectable IO for tests. 13 tests; lint/build/typecheck/coverage green. Next: M1.3.

- 2026-10-26 · M1.1: root ESLint (strict, bans `localeCompare`/`any`), Prettier (markdown excluded so this file's format is safe), `pnpm lint`, GitHub Actions CI. Schema code reformatted; lint/build/typecheck/test/coverage green. Next: M1.2.
- 2026-10-25 · Phase 1: docs written (DECISIONS, DESIGN, GRAPH_SCHEMA + packages/schema, ROADMAP, TESTING, EVALUATION, DESIGN_SYSTEM, UX, SECURITY), pnpm + Turborepo workspace set up, schema tests green (13 tests, 98.6% coverage). Next: M1.1.
