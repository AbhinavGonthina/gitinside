STATUS: RUNNING
AUTONOMY: ON

# Progress

The single source of truth for what to do next. Mirrors [docs/ROADMAP.md](docs/ROADMAP.md).

**Rules**
- Lines 1–2 are read by `scripts/autopilot.ps1`. Keep the exact formats: `STATUS: RUNNING | BLOCKED <reason> | DONE` and `AUTONOMY: ON | OFF`.
- Work on the **first unchecked task that isn't blocked**. Don't skip ahead otherwise.
- Task line format: `- [ ] M<n>.<k> <title> {model: opus|sonnet}`. The script reads the model tag of that same first unblocked task. Untagged tasks default to opus.
- Blocked tasks get ` {blocked: <reason or issue #>}` appended and are skipped until unblocked. Remove the tag when resolved.
- If a task is too big for one commit, split it into `M<n>.<k>a`, `M<n>.<k>b`, … before starting.
- After finishing a task: check it, add a 2–4 line note under **Session notes** (newest first), commit, push.

## Current task
M1.1. Repo tooling: ESLint + Prettier + CI

## Needs Abhinav
(Mirrors open `needs-abhinav` issues in gitinside-planning. Autopilot keeps working on other tasks.)
- none yet

## Blockers
- none

## Milestones

### M1: Analyzer CLI
- [ ] M1.1 Repo tooling: ESLint (typescript-eslint strict) + Prettier + root lint script + GitHub Actions CI (lint, typecheck, test, coverage) {model: sonnet}
- [ ] M1.2 packages/analyzer scaffold: library API `analyze(dir)`, CLI `gitinside analyze <path> [--out]` {model: sonnet}
- [ ] M1.3 Inventory: deterministic walk, ignore rules, generated-file detection, 20k limit, 2 MB skip warnings {model: opus}
- [ ] M1.4 Workspace detection (npm/yarn/pnpm/Turborepo/Nx/Lerna) → service nodes; single-package fallback {model: opus}
- [ ] M1.5 Per-service TS program: tsconfig loading, synthesized defaults, paths/baseUrl, no node_modules, warnings {model: opus}
- [ ] M1.6 Module and file nodes with content hashes {model: sonnet}
- [ ] M1.7 Symbol extraction (functions, classes, methods, exported consts) {model: opus}
- [ ] M1.8 Import edges incl. cross-workspace package imports {model: opus}
- [ ] M1.9 Call edges for locally resolved calls {model: opus}
- [ ] M1.10 Express route detector (methods, router.route, mount composition, nested/imported routers, handles edges) {model: opus}
- [ ] M1.11 Next.js detector (app router route.ts, pages/api, pages, dynamic segments, route groups) {model: opus}
- [ ] M1.12 Prisma detector (schema models/fields/datasource, client reads/writes, $queryRaw unresolved) {model: opus}
- [ ] M1.13 Graph assembly + canonical serialization + validation before write {model: opus}
- [ ] M1.14 Fixtures (express-basic, express-nested-routers, next-app-router, next-pages-api, prisma-relations, pnpm-monorepo, syntax-error, no-tsconfig) + golden tests {model: sonnet}
- [ ] M1.15 Determinism test + analyzer coverage ≥ 85% + analysis benchmark baseline {model: opus}
- [ ] M1.16 Milestone verification + docs/milestones/M1-review.md + tag m1 {model: opus}

### M2: Cross-service links + infra
- [ ] M2.1 HTTP call-site collection (fetch, axios.*, axios(config), axios.create instances via imports) {model: opus}
- [ ] M2.2 URL expression normalizer (literals, templates, concat, imported consts, env bases, new URL) {model: opus}
- [ ] M2.3 One-level wrapper inlining; WRAPPER_DEPTH beyond {model: opus}
- [ ] M2.4 Route matcher with confidence scoring, ambiguity, route index {model: opus}
- [ ] M2.5 Unresolved nodes/edges with reasons; literal external hosts → external nodes {model: opus}
- [ ] M2.6 External SDK detector (allowlist) → external_call edges {model: sonnet}
- [ ] M2.7 docker-compose + .env detectors (names/schemes only) + stores edges {model: opus}
- [ ] M2.8 BullMQ/queue client detection → publishes/consumes {model: sonnet}
- [ ] M2.9 Pattern fixtures + golden tests + "no call site dropped" test + secret-leak test {model: opus}
- [ ] M2.10 docs/walkthroughs/resolver.md (line-by-line, diagrams, explain-it-back checklist) {model: opus}
- [ ] M2.11 Milestone verification + M2-review.md + tag m2 {model: opus}

### M3: Accuracy eval harness
- [ ] M3.1 eval/ package scaffold + ground-truth format per docs/EVALUATION.md {model: sonnet}
- [ ] M3.2 Select 5 repos, pin SHAs in eval/repos.json {model: opus}
- [ ] M3.3 Draft labels for repos 1–2 (independently of analyzer output; commit before scoring) {model: opus}
- [ ] M3.4 Draft labels for repos 3–5 {model: opus}
- [ ] M3.5 Scoring script (overall / per repo / per confidence, FP and FN lists) {model: opus}
- [ ] M3.6 Report generator → eval/results/ ("Pending owner review") + pnpm eval reproducibility {model: sonnet}
- [ ] M3.7 Open needs-abhinav issue: review a seeded random 20% of labels {model: sonnet}
- [ ] M3.8 Milestone verification + M3-review.md + tag m3 {model: opus}

### M4a: Design system + prototype (design gate)
- [ ] M4a.1 packages/viewer scaffold (React, Vite lib, Storybook) {model: sonnet}
- [ ] M4a.2 Tokens (dark default + light), self-hosted Geist fonts {model: opus}
- [ ] M4a.3 Icon system: Simple Icons brand mapping + custom glyph set for kinds {model: opus}
- [ ] M4a.4 Node components per kind, all states {model: opus}
- [ ] M4a.5 Edge components (confidence styles, labels, flow, broken, arrows) {model: opus}
- [ ] M4a.6 Chrome components (top bar, inspector, breadcrumbs, minimap shell, legend, palette shell) {model: sonnet}
- [ ] M4a.7 Static clickable prototype on a fixture graph {model: opus}
- [ ] M4a.8 Visual regression baseline (stories, light + dark, Linux CI) {model: sonnet}
- [ ] M4a.9 M4a-review.md with screenshots + needs-abhinav design-approval issue; UI work then waits for approval {model: opus}

### M4b: Interactive explorer
- [ ] M4b.1 Viewer graph model: hierarchy index, edge aggregation, visibility {model: opus}
- [ ] M4b.2 ELK layout in a Web Worker with stable ordering + layout cache {model: opus}
- [ ] M4b.3 Semantic drill-down with animated in-place transitions + reduced motion {model: opus}
- [ ] M4b.4 Breadcrumbs, minimap, pan/zoom/fit {model: sonnet}
- [ ] M4b.5 Inspector (summary template, facts, connections, Shiki preview, Open on GitHub) {model: sonnet}
- [ ] M4b.6 Trace mode (path BFS, dimming, pulse, step player, cross-level behavior) {model: opus}
- [ ] M4b.7 Ctrl+K command palette {model: sonnet}
- [ ] M4b.8 Filters {model: sonnet}
- [ ] M4b.9 Deep links {model: sonnet}
- [ ] M4b.10 Export SVG / PNG / Mermaid {model: sonnet}
- [ ] M4b.11 Keyboard navigation + screen-reader announcements {model: opus}
- [ ] M4b.12 Onboarding hints + empty/error states {model: sonnet}
- [ ] M4b.13 Viewport culling + bench/render fps at 2,000 nodes {model: opus}
- [ ] M4b.14 Playwright E2E + visual tests {model: sonnet}
- [ ] M4b.15 Milestone verification + M4b-review.md + tag m4 {model: opus}

### M5: Website (public) + live badge
- [ ] M5.1 Open needs-abhinav signup issues (Oracle VM, Neon, R2, Vercel, DNS CNAME) with step-by-step instructions {model: sonnet}
- [ ] M5.2 apps/web Next.js scaffold, landing page, viewer integration {model: sonnet}
- [ ] M5.3 Drizzle schema + migrations (local Postgres in Docker for dev/CI) {model: sonnet}
- [ ] M5.4 apps/worker: BullMQ worker + HMAC enqueue API + safe tarball extraction + child-process limits {model: opus}
- [ ] M5.5 Worker: R2 upload, Postgres writes, progress events {model: sonnet}
- [ ] M5.6 /api/analyze: URL parsing, latest SHA, cache, rate limits, dedupe {model: opus}
- [ ] M5.7 Progress page with real stages + queue position (SSE) {model: sonnet}
- [ ] M5.8 Diagram page + check-on-view re-analysis {model: sonnet}
- [ ] M5.9 Badge + live image endpoint + "Add to README" {model: sonnet}
- [ ] M5.10 Hardened worker Docker image + infra/oracle provisioning script + docs {model: opus}
- [ ] M5.11 Security test suite with malicious fixtures {model: opus}
- [ ] M5.12 Snapshot retention + quota check {model: sonnet}
- [ ] M5.13 Deploy + production smoke test on a real public repo {model: opus}
- [ ] M5.14 Milestone verification + M5-review.md + tag m5 {model: opus}

### M6: Graph diff + incremental analysis
- [ ] M6.1 packages/diff scaffold + GraphDiff types in schema {model: sonnet}
- [ ] M6.2 Node/edge classification with per-kind fingerprints {model: opus}
- [ ] M6.3 Rename/move detection with tuned thresholds {model: opus}
- [ ] M6.4 Broken-edge detection incl. head re-resolution {model: opus}
- [ ] M6.5 Property tests (fast-check) {model: opus}
- [ ] M6.6 gitinside diff CLI (paths or git refs) + Mermaid summary {model: sonnet}
- [ ] M6.7 Incremental cache (content-hash facts, importer invalidation, disk LRU) {model: opus}
- [ ] M6.8 Benchmarks: full vs incremental on a large TS monorepo {model: sonnet}
- [ ] M6.9 Viewer diff mode (overlay, stable layout, changes list) {model: opus}
- [ ] M6.10 docs/walkthroughs/diff.md {model: opus}
- [ ] M6.11 Milestone verification + M6-review.md + tag m6 {model: opus}

### M7: PR backtesting
- [ ] M7.1 Select ~8 repos + pin window in eval/backtest/repos.json {model: opus}
- [ ] M7.2 Replay script (merged PRs, incremental analyze, diff, collect broken edges) {model: opus}
- [ ] M7.3 Follow-up fix detection {model: opus}
- [ ] M7.4 Classification of flagged breaks (drafted, labeled as such) {model: opus}
- [ ] M7.5 Report → eval/backtest/results/ {model: sonnet}
- [ ] M7.6 Milestone verification + M7-review.md + tag m7 {model: opus}

### M8: Sign-in + private repos + PR bot
- [ ] M8.1 needs-abhinav: register GitHub App (permissions per ADR-0009) + secrets {model: sonnet}
- [ ] M8.2 GitHub sign-in (identity only), sessions, dashboard {model: sonnet}
- [ ] M8.3 Install flow + installation webhooks + private snapshot prefix {model: opus}
- [ ] M8.4 Per-view access checks (60s cache), private isolation, noindex {model: opus}
- [ ] M8.5 Uninstall → immediate deletion (tested) {model: opus}
- [ ] M8.6 PR webhook → diff job → comment + Check Run (updated in place) {model: opus}
- [ ] M8.7 Push webhook → badge refresh {model: sonnet}
- [ ] M8.8 Security tests (signatures, revocation, cross-tenant isolation) {model: opus}
- [ ] M8.9 Switch autopilot to PR flow reviewed by GitInside's bot; update CLAUDE.md {model: opus}
- [ ] M8.10 Milestone verification + M8-review.md + tag m8 {model: opus}

### M9: Launch-ready (no public announcement)
- [ ] M9.1 Choose + hand-verify 3 OSS demo repos; landing gallery {model: opus}
- [ ] M9.2 Final eval + benchmarks; README numbers with links {model: sonnet}
- [ ] M9.3 README (slogan, GIF with trace first, quickstart, architecture, results) {model: sonnet}
- [ ] M9.4 Docs pages (how it works, limits, privacy) + root SECURITY.md {model: sonnet}
- [ ] M9.5 Blog post draft + needs-abhinav edit/publish-decision issue {model: opus}
- [ ] M9.6 Full regression + axe accessibility audit {model: opus}
- [ ] M9.7 Milestone verification + M9-review.md + tag m9; set STATUS: DONE {model: opus}

## Session notes
(Newest first. 2–4 lines per task.)

- 2026-10-25 · Phase 1: docs written (DECISIONS, DESIGN, GRAPH_SCHEMA + packages/schema, ROADMAP, TESTING, EVALUATION, DESIGN_SYSTEM, UX, SECURITY), pnpm + Turborepo workspace set up, schema tests green (13 tests, 98.6% coverage). Next: M1.1.
