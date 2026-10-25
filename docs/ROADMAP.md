# Roadmap

Milestones from `../gitinside-planning/SPEC.md` §6 (order: ADR-0016). Each is 1–2 weeks. Each task is roughly one commit-sized unit; split it in `PROGRESS.md` if it's bigger. `PROGRESS.md` mirrors these tasks as checkboxes and is the single source of truth for what's next.

**Every milestone ends with** the verification protocol in `CLAUDE.md`:
1. The full test suite.
2. Coverage check.
3. Eval/bench if relevant.
4. Fresh-eyes review.
5. Smoke test.
6. `docs/milestones/M<n>-review.md`.
7. Tag `m<n>`.

---

## M1: Analyzer CLI
**Goal:** `gitinside analyze <path>` writes a valid `architecture.json` for files, symbols, imports, Express/Next routes, Prisma models, and workspace services.

**Tasks**
1. Repo tooling: ESLint (typescript-eslint, strict) + Prettier, root `lint` script, GitHub Actions CI (lint, typecheck, test on push).
2. `packages/analyzer` scaffold: package, CLI entry (`gitinside analyze <path> [--out file]`), and an `analyze(dir): ArchitectureGraph` API.
3. Inventory: deterministic file walk, ignore rules, generated-file detection, 20k source-file limit (`LIMIT_FILES`), 2 MB per-file skip with a warning.
4. Workspace detection: npm/yarn `workspaces`, `pnpm-workspace.yaml`, Turborepo/Nx/Lerna. Single-package fallback produces service nodes.
5. Per-service TS program: tsconfig loading, synthesized defaults, `paths`/`baseUrl`, no `node_modules`, warnings for missing config and syntax errors.
6. Module and file nodes: top-level source folders become modules; content hashes on files.
7. Symbol extraction: functions, classes, methods, exported consts. `symbol` nodes with source locations.
8. Import edges (file → file), including cross-workspace package imports.
9. Call edges (symbol → symbol) for calls resolved to local declarations.
10. Express route detector: methods, `router.route()`, `app.use` mount composition, nested and imported routers, `handles` edges, documented unhandled patterns.
11. Next.js detector: app router `route.ts` exports, `pages/api`, pages (`page.tsx`, `pages/**`), dynamic segments, route groups.
12. Prisma detector: `schema.prisma` models/fields/datasource, client usage → `reads`/`writes` edges, `$queryRaw` → unresolved.
13. Graph assembly + canonical serialization + Zod validation before write.
14. Fixture repos (`fixtures/`): express-basic, express-nested-routers, next-app-router, next-pages-api, prisma-relations, pnpm-monorepo. Golden snapshot tests.
15. Determinism test (analyze each fixture twice, byte-compare). Analyzer coverage ≥ 85%.

**Acceptance criteria**
- Every fixture produces a schema-valid graph matching its golden file.
- Two runs are byte-identical.
- CI is green.
- Analyzer line coverage ≥ 85%.

**Required tests:** unit tests per detector; golden snapshots per fixture; determinism; limit tests (file count, file size).

---

## M2: Cross-service links + infra
**Goal:** frontend HTTP calls linked to backend routes with confidence; datastores, queues, and externals detected.

**Tasks**
1. HTTP call-site collection: `fetch`, `axios.*`, `axios(config)`, axios instances via `create({ baseURL })` followed through imports.
2. URL expression normalizer: literals, template literals, concatenation, imported consts, env-var bases, `new URL`, query stripping. Unresolved reasons for everything else.
3. One-level wrapper inlining (`get(path)` → `fetch(BASE + path)`); deeper wrappers get `WRAPPER_DEPTH`.
4. Route matcher: method + segment alignment, confidence scoring (exact/pattern/heuristic), ambiguity handling, route index by method + first literal segment.
5. Unresolved nodes and edges with reasons; literal external hosts become `external` nodes.
6. External SDK detector (allowlist: stripe, @aws-sdk/*, resend, openai, twilio, @sendgrid/*, etc.) → `external_call` edges.
7. docker-compose detector (datastores and queues by image) and `.env*` detector (key names and URL schemes only; values discarded). Model → datastore `stores` edges.
8. BullMQ and known queue client detection (`new Queue(name)`, `queue.add`, `new Worker(name)`) → `publishes`/`consumes`.
9. Fixtures: template-literal fetch, axios baseURL instance, env-base heuristic, ambiguous routes, removed route still called (for M6), external SDK, compose + env. Golden tests.
10. `docs/walkthroughs/resolver.md`: line-by-line walkthrough with diagrams and an explain-it-back checklist (D11.1).

**Acceptance criteria**
- Each pattern fixture produces the expected edge and confidence.
- No call site is silently dropped: every collected call yields an edge, either resolved or unresolved. This is asserted by a test.
- Secrets never appear in output (test with fake secret values).

**Required tests:** unit tests for the normalizer (table-driven) and matcher; property tests for normalizer idempotence; golden fixtures; secret-leak test.

---

## M3: Accuracy eval harness
**Goal:** reproducible precision and recall for cross-service links on 5 real repos.

**Tasks**
1. `docs/EVALUATION.md` ground-truth format finalized; `eval/` package scaffold.
2. Pick 5 public full-stack TS repos (varied shapes, within limits, permissive licenses). Pin commit SHAs in `eval/repos.json`.
3. Draft labels per repo from reading the code, independently of analyzer output: `eval/labels/<repo>.json`.
4. Scoring script: match predicted vs. labeled edges; precision/recall overall, per confidence level, and per repo; list of false positives and negatives.
5. Report generator → `eval/results/<date>-<analyzerVersion>.md` (committed), marked "pending review".
6. Open a `needs-abhinav` issue: review a random 20% sample of labels (sample list generated deterministically, seeded by date).
7. CI job that runs the eval on demand (`pnpm eval`), plus a rule: analyzer PRs after M3 report the eval delta.

**Acceptance criteria:** `pnpm eval` reproduces the committed report byte-for-byte from pinned SHAs; the report lists methodology and limitations.

---

## M4a: Design system + clickable prototype (design gate)
**Goal:** the visual language, approved by Abhinav before the full explorer is built.

**Tasks**
1. `packages/viewer` scaffold (React, Vite library mode, Storybook).
2. Design tokens (CSS variables) for dark (default) and light per `docs/DESIGN_SYSTEM.md`; fonts self-hosted.
3. Icon set: technology logos (Simple Icons, mapped from `service.framework`, datastore engine, external host) and a custom icon set for generic kinds. Every icon has a Storybook story.
4. Node components per kind (service card, module, file, symbol, route, page, model, datastore, queue, external, unresolved) with states: default, hover, selected, dimmed, traced, diff added/changed/removed.
5. Edge components: confidence styles, labels, flow particles, broken-edge style, arrowheads.
6. Chrome components: top bar, inspector panel, breadcrumbs, minimap shell, legend, command palette shell, buttons and toggles.
7. Static clickable prototype on a fixture graph (drill one level, select, a fake trace).
8. Visual regression baseline (Playwright screenshots of stories in light and dark).
9. Review doc with screenshots, then open a `needs-abhinav` design-approval issue. **UI work stops** until it's approved; non-UI tasks continue.

**Acceptance criteria:** every component state in Storybook; screenshots in light and dark; nothing in the anti-pattern list in DESIGN_SYSTEM.md §2; Abhinav's approval recorded in the issue.

---

## M4b: Interactive explorer
**Goal:** the full explorer per `docs/UX.md`, except diff mode.

**Tasks**
1. Graph model in the viewer: hierarchy index, edge aggregation to visible ancestors, visibility by expansion state.
2. ELK layout in a Web Worker; stable ordering from layout hints; layout cache per expansion state.
3. Semantic drill-down with animated expand-in-place transitions; `prefers-reduced-motion`.
4. Breadcrumbs, minimap, pan/zoom controls, fit.
5. Inspector: summary template from graph facts, facts, connections (clickable), Shiki code preview, Open on GitHub.
6. Trace mode: pick a page or route, compute the path (BFS over http/handles/calls/reads/writes/external_call), dim the rest, step-through player with each hop's code.
7. Ctrl+K command palette (fuzzy search over nodes and routes).
8. Filters (layer, kind, confidence, folder, hide tests/config).
9. Deep links: URL encodes repo, sha, expansion path, selection, trace.
10. Export: SVG, PNG, Mermaid of the current view.
11. Keyboard navigation (arrows, Enter, Esc), focus visibility, screen-reader announcements.
12. Onboarding hint (3 steps, dismissible for good), empty and error states.
13. Performance: viewport culling; `bench/render` measuring fps at 2,000 visible nodes.
14. Playwright E2E on a fixture (load, drill down, select, trace, open source link) + visual tests.

**Acceptance criteria:** UX.md interactions all work; E2E and visual tests green; ≥ 60fps pan/zoom at 2,000 nodes recorded in `bench/results/`.

---

## M5: Website (public) + live badge (early-December demo)
**Goal:** anyone can paste a public repo URL on `gitinside.abhinavgonthina.dev`.

**Tasks**
1. `apps/web` Next.js scaffold (App Router), landing page with the slogan, URL input, viewer integration.
2. Drizzle schema + migrations (DESIGN.md §10) against local Postgres; Neon in production.
3. `apps/worker`: BullMQ worker (concurrency 2), enqueue API with HMAC, tarball fetch with safe extraction, child-process analysis with limits, R2 upload, Postgres writes, progress events.
4. `/api/analyze`: URL parsing, latest SHA, cache lookup, rate limits (5/h per IP), enqueue, dedupe by job ID.
5. Progress page: real pipeline stages and queue position (SSE).
6. Diagram page `/<owner>/<repo>[/<sha>]` with check-on-view re-analysis of the default branch.
7. Badge and live image endpoint (`/api/badge/:owner/:repo.svg`) + "Add to README" snippet.
8. Docker image for the worker (non-root, read-only fs, tmpfs, egress allowlist) + VM provisioning script (`infra/oracle/provision.sh`) + docs.
9. Security test suite: malicious fixtures (postinstall, huge files, symlink escape, path traversal, zip bomb, deeply nested dirs).
10. Snapshot retention job (DESIGN.md §10) + quota check.
11. `needs-abhinav` issues, opened as early as possible in M5: Oracle VM signup, Neon, R2, Vercel, DNS CNAME.
12. Deploy + smoke test on a real public repo.

**Acceptance criteria:** paste URL → progress → diagram works in production; second request served from cache; rate limit enforced; security tests green; badge renders in a GitHub README.

---

## M6: Graph diff + incremental analysis
**Goal:** `gitinside diff <base> <head>` and a diff view with broken-edge detection.

**Tasks**
1. `packages/diff` scaffold + `GraphDiff` types (in `packages/schema`).
2. Node/edge classification (added/removed/modified/unchanged) with fingerprints per kind.
3. Rename and move detection (file content similarity, symbol body hash), with thresholds tuned on fixtures.
4. Broken-edge detection (DESIGN.md §8.4), including re-resolution of head call sites against removed targets.
5. Property tests (fast-check): empty self-diff, apply(base, diff) = head, add/remove symmetry, broken edges never target unchanged nodes.
6. CLI `gitinside diff` (paths or git refs via `git worktree`), Mermaid summary output.
7. Incremental cache: per-file facts keyed by content hash; importer invalidation; disk LRU.
8. Benchmarks: full vs. incremental on a large public TS monorepo → `bench/results/`.
9. Viewer diff mode: base/head toggle, overlay colors, pulsing broken edges, stable layout (pinned base positions), changes list with fly-to.
10. `docs/walkthroughs/diff.md` (D11.2).

**Acceptance criteria:** fixtures (removed route still called, renamed file, changed route method) yield the expected diffs; property tests green; diff coverage ≥ 85%; measured incremental speedup committed.

---

## M7: PR backtesting
**Goal:** honest numbers on real breaks caught in historical PRs.

**Tasks**
1. Select about 8 public repos with separate frontend and backend; pin them in `eval/backtest/repos.json`.
2. Replay script: list merged PRs (GitHub API), analyze base and merge commit (incremental), diff, collect broken edges.
3. Follow-up check: did a later commit fix each flagged break (target restored or call removed)?
4. Manual classification of a sample of flags as true or false positive (Claude drafts; noted as such).
5. Report → `eval/backtest/results/<date>.md` with exact methodology; no inflation.

**Acceptance criteria:** the report is reproducible from pinned inputs and states counts, precision of flags, and limitations.

---

## M8: Sign-in + private repos + PR bot
**Goal:** private repos via the GitHub App; PR comments and Check Runs.

**Tasks**
1. `needs-abhinav`: register the GitHub App (permissions per ADR-0009, webhook URL, secrets into local env and Vercel env).
2. GitHub sign-in (OAuth identity only), session handling, dashboard of installed repos.
3. Install flow + `installation`/`installation_repositories` webhooks; private snapshot prefix.
4. Per-view access check with 60s cache; private results never cached publicly; `noindex`.
5. Uninstall webhook → immediate deletion of private data (tested).
6. PR webhook → diff job → comment (Mermaid summary + link to the interactive diff) + Check Run (broken count); comment updated in place on new pushes.
7. Push webhook → badge refresh for installed repos.
8. Security tests: webhook signature verification, access revocation, cross-tenant isolation.
9. Switch the autopilot workflow to PRs reviewed by GitInside's own bot (D12.3); update `CLAUDE.md`.

**Acceptance criteria:** end to end on a test private repo (install → diagram → PR comment → uninstall deletes data); security tests green.

---

## M9: Launch-ready (no public announcement)
**Goal:** polished and ready to announce whenever Abhinav decides.

**Tasks**
1. Choose 3 well-known OSS demo repos (zero wrong edges verified by hand); pre-analyze them; landing page gallery.
2. Final benchmarks and eval rerun; README numbers with links to committed reports.
3. README: slogan headline, what it is, demo GIF (trace mode first), quickstart, architecture diagram, results.
4. Docs pages (how it works, limits, privacy, self-hosting notes).
5. Technical blog post draft (`docs/blog/resolver-post.md`): "How GitInside matches frontend calls to backend routes without running code", in Abhinav's voice. `needs-abhinav`: edit and decide where and when to publish.
6. Full regression: all tests, visual, E2E, security; accessibility audit (axe).

**Acceptance criteria:** all green; demo repos clean; nothing posted publicly (D13.2).
