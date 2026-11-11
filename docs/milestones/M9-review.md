# M9 review: launch-ready

**Status: draft (M9.7a, 2026-11-11).** The milestone checks pass and production works for a signed-out user. The fresh-eyes review found one high-severity bug (G1: a type annotation hides an SDK client's base, a wrong edge in TypeScript code; the JS demo pins aren't affected) and no security hole. Its 14 findings are planned as M9.7b–M9.7f (table below), and `m9` is tagged after them (M9.7z). · **Range:** `eb707b4..9cc7c5a` (M9.1a1 `0086e03`, PR #41, to M9.6, PR #84). The `m8` tag sits after PRs #41–#50 (M9.1a1–a3f merged before M8.10g), so `m8..HEAD` misses them; this review covers both parts. · **Checked at:** `9cc7c5a`

## What was built

M9 gets GitInside ready to show: three well-known repos whose every inferred edge was read by hand, a landing gallery that opens them, a README and docs that say what it does and how well, final numbers, a security policy, a blog draft, and an accessibility audit on every push. Nothing was posted publicly (D13.2).

| Piece | Where | What it does |
|---|---|---|
| Demo checks | `docs/demos/` (M9.1a1–a3f) | anything-llm (873 inferred edges), taxonomy (29), maxun (142), pinned to one commit each, every edge given a verdict: 779 correct, 0 wrong, 265 unresolved with a reason |
| Analyzer fixes from the checks | `packages/analyzer` (M9.1a3a–a7b, ADR-0202 amendment, ADR-0251–0254) | An env base's fallback and example path as one prefix; root catch-alls not taking stray literal paths; SDK clients' `baseURL`/`endpoint`/`baseUrl` read; `new URL("./x", import.meta.url)` fetched as a module asset; `readdirSync` router loops mounted; `fetchEventSource` collected; URL bases in instance, static, `#private`, and object members read |
| Pins in production | `packages/db/src/demos.ts`, `lib/repoView.ts` (ADR-0255, 0257) | A pin's permalink with no current-version analysis queues that commit; retention never evicts a pin |
| Version guard | `packages/analyzer/src/version.ts` (ADR-0256) | A digest of every fixture's golden graph per `ANALYZER_VERSION`, so output can't change under an old version (0.2.0 → 0.3.0 → 0.3.1) |
| Versioned graph URL | `/api/graph/…?v=<version>` (ADR-0258) | The CDN's day-long copy can't serve an older version's graph after a bump |
| Landing gallery | `app/page.tsx`, `/api/diagram/<owner>/<repo>/<sha>.svg` (ADR-0259) | Each pin's own diagram image as its thumbnail, counts from its record (a test fails on drift or any `wrong`) |
| Token fallback | `apps/worker/src/github.ts` (ADR-0260) | A public job refused by an org's token policy asks once more without the worker's token; `DOWNLOAD_REFUSED` has its own message |
| Viewer fixes | `framing.ts`, `fit.ts`, `camera.ts`, `image/layout.ts` (ADR-0261) | First view framed below the hint card; the trace's step framed on Play and clear of the minimap; README image labels slid apart or left off with a count |
| Infra test folders | `packages/analyzer/src/infra.ts` (ADR-0262) | Compose and env files under `test`, `fixtures`, … folders aren't the repo's infrastructure (this repo: 9 infra boxes → 1) |
| README | `README.md`, `docs/media/trace*.gif` | Slogan, trace GIF, what it is, Why I built this (MOTIVATION.md verbatim), try it, quickstarts, architecture, results with links |
| Docs pages | `/how-it-works`, `/limits`, `/privacy`, `/self-hosting` | Every Limits number and every cookie checked against the constant that sets it |
| Security policy | `SECURITY.md` | Scope, GitHub's private reporting (on since planning #28), what happens next |
| Blog draft | `docs/blog/resolver-post.md` | How the resolver matches calls to routes; numbers checked by `blogPost.test.ts`. Abhinav's decision (#29): not published separately; it stays in the repo |
| Accessibility audit | `apps/web/e2e/a11y.e2e.ts` (ADR-0263) | axe's WCAG 2.2 A/AA rules on 22 screens × 2 themes on every push |
| Final eval and benchmarks | `eval/results/2026-11-10-0.3.0.md`, `bench/results/2026-11-1*` (M9.2) | Blind batch 6, cal.com full, incremental, and render benchmarks |

## Results (exactly as measured)

- **Tests (local at `9cc7c5a`, uncached, `npx turbo run test --force --concurrency=1 --continue`):** 14 of 15 tasks passed; web's task ended with `ELIFECYCLE` and no test summary (no assertion failed: its process died mid-run while a production smoke script and a review subagent also ran). Web alone (`pnpm --filter @gitinside/web test -- --silent`): 1,135 passed. Totals: 5,427 passed, 6 skipped. Analyzer 1,492, viewer 1,140, web 1,135, worker 868 (+1 skipped), db 272 (+5 skipped), eval 227, diff 162, bench 95, schema 36. Against M8's re-check at `87c3a9d` (5,255): web +81, analyzer +50, viewer +19, worker +16, db +5, eval +1.
- **E2E, visual, container, real Postgres:** CI on `8368f29` (M9.6's last commit, the tree merged as `9cc7c5a`), run 43092910760: check, worker-image, web-e2e (with the `a11y` project), and visual all green.
- **Coverage** (CI run 43092910760 on `8368f29`, lines / branches): analyzer 97.67% / 90.97%; diff 99.01% / 93.84%; web 97.65% / 95.81%; worker 96.48% / 94.14%; db 99.49% / 93.99%; viewer 99.33% / 94.69%; eval 98.5% / 93.69%; schema 94.8% / 88.88%; bench 100% / 92.57%. Every target met (analyzer and diff ≥ 85%, the rest ≥ 70%); against M8's re-check (lines), analyzer +0.01, web +0.17, viewer unchanged.
- **Eval:** `pnpm eval --check` reproduced `eval/results/2026-11-11-0.3.1.md` byte for byte.
- **Blind batch 6** (M9.2c, analyzer 0.3.0, scored once): precision 100.0% (521 of 521), recall 69.0% (521 of 755), 6 of 16 repos mapped completely. [Report](../../eval/results/2026-11-10-0.3.0.md#held-out-batch-6-unseen), [diagnosis](../../eval/results/2026-11-batch6-diagnosis.md).
- **Demo repos:** 1,044 inferred edges checked by hand: 779 correct, 0 wrong, 265 unresolved. In production at 0.3.1 (this task, `apps/web/dist/m97a-smoke.mjs`): anything-llm 7,784 nodes, 12,630 edges, 873 inferred, 10,560,747 bytes; taxonomy 529 / 542 / 29 / 439,847; maxun 1,525 / 2,323 / 142 / 1,999,969. Each count equals the checked record and each size the 0.3.0 graph's (the version string is the same length); not hash-compared at 0.3.1 yet (F6).
- **Benchmarks** (M9.2d): cal.diy in the worker image on 1 vCPU, median 49.4 s (EPYC 9V74) and 42.3 s (9V45); incremental cal.com 16.8× unchanged, 1.02× median over 10 real commits; render 59.9 fps at 2,000 visible nodes. README's Results link each report.

## Key decisions and trade-offs

- **A hand check of every inferred edge, not a sample** (M9.1a1): "zero wrong edges" (D13.4) is a claim about every line on the demo diagrams, so each of 1,044 was read at the pin. It took 15 tasks (M9.1a1–a7b), but it found what the eval couldn't (below).
- **Fix the analyzer, never the demo** (`docs/demos/README.md`): a `wrong` verdict blocked a repo until a general fix with a test and an eval delta, or a replacement. No repo-specific rule went in.
- **The output's digest guards the version** (ADR-0256): production caches by (repo, commit, version), and 0.2.0 had shipped dozens of output changes. A fixture digest per version makes a change fail CI until the version moves.
- **Pins queue themselves** (ADR-0255, 0257): a gallery link must work however far the default branch moves and after every version bump, so a pin's permalink queues its commit, charged to the repo's limits, and retention keeps it.
- **Skip test folders' infra rather than mark it** (ADR-0262): the README image and the bot apply no filters, so a mark would still draw fixtures' databases.
- **An axe rule accepted narrowly** (ADR-0263): `label-content-name-mismatch` on canvas boxes only, after checking each box's name starts with its visible name, instead of long box names.

## Hardest problem: wrong edges the eval couldn't see

The eval's report puts precision at 100% on every labeled set (README's Results), yet the first read of anything-llm's 978 inferred edges found 244 wrong ones, the catch-all check 11 more, and the SDK check 117 more: 372 in all. The eval labels frontend requests to routes; it never labels SDK clients, a backend's own catch-all 404 handler, or the request a base from `.env.example` builds in a repo shaped like this one, so none of those mistakes could show up in its numbers.

Each cause had to become a general rule. The worst, 244 edges: `VITE_API_BASE || "/api"` with `.env.example`'s `…/api` was read as two prefixes, `/api/api/admin/users`, which only the `app.all("*")` handlers could take, so every literal-path request went to both services' 404s (M9.1a3a, ADR-0202 amendment). The SDK detector sent every call on a client to the SDK's default host even when the client was built with another `baseURL` (117 edges, M9.1a3e2a). Each fix came with a red fixture test, an eval delta, and a recheck of every edge it touched. The lesson in `docs/demos/README.md` stands: these repos show the bar met where it was worked for, not how often it holds elsewhere.

## What's still weak

- **Recall on unseen code is 69.0%** (batch 6), below the 80% target. One repo's `.replace(/\/+$/, "")` base accounts for 141 misses; none of batch 6's causes is fixed, so it stays unseen.
- **The accuracy labels are Claude's** and Abhinav's 20% review (planning #1) is still open, so every accuracy number is pending review.
- **The backtest flagged one PR's 5 breaks**, all within one service; no cross-service break was flagged, and recall isn't measured.
- **A demo pin whose analysis fails stays stuck** (F1) and costs a GitHub call per view while it's in flight (F2), until M9.7b.
- **SDK base reading was tested only in JS** (G1, G2): TypeScript's typed fields and branching constructions draw wrong or partial edges, until M9.7d. The demo check found the SDK gap in a JS repo, and the fixtures followed that repo's shape.
- **anything-llm's first view** is a tall column of 50 outside APIs at 40% with the services in a corner (smoke test); readable only after breaking it down.
- **No real screen reader** has been tried; axe covers part of WCAG.
- **cal.diy got 16–26% slower** from 0.2.0 to 0.3.0 on the same CPU models, mostly in `imports` and `http`; the cause hasn't been looked for.

## Fresh-eyes review

Two subagents with no prior context reviewed the range read-only against SPEC.md, DESIGN.md, TESTING.md, and SECURITY.md: one `m8..9cc7c5a` (everything after the tag), one `eb707b4..7f81efa` (M9.1a1–a3f, before it). The second found the one high-severity bug (G1, in M9.1a3e2a's SDK base reading); neither found a security hole. Each finding below was traced in the code by its reviewer; F1, F4, F5, G1, and the smoke test's F8 were checked again in this task.

They confirmed as correct:
- **Token fallback:** dropped only for the worker's own public token, only on a non-rate-limit `403`, once; redirects still bounded; an installation token never dropped; the download host never gets a token.
- **Versioned graph URLs:** only the current version kept; the version-mismatch `307` is `no-store` and after the private check; cache tags cover the versioned URLs, so purges still work.
- **Commit image route:** SHA checked, no viewer (a private repo only gets the link-only badge), no GitHub call except for pins.
- **Demo pins:** matched by GitHub ID; exempt from both eviction rules; gallery counts add up (873 + 29 + 142 = 1,044); plain `<a>` (no prefetch side effects); the job page ignores a `?commit=` that isn't a full SHA.
- **Version guard:** digests append-only, versions ascending, no two sharing a digest.
- **README and blog numbers** match the committed reports and code; `SECURITY.md`'s private reporting is enabled.
- **M9.1a1–a3f's matcher:** no `localeCompare`, clock, randomness, or map order reaching output; SDK requests sorted by site; fallback segments only from whole literal segments; `isCatchAll` keeps `/:id`, `/`, catch-alls under a literal, and Next routes under a `basePath`; AzureOpenAI's base order matches the SDK; an `unknown` base's label goes through `redactedText`, so an API key in the options is masked.

| # | Severity | Finding | Plan |
|---|---|---|---|
| F1 | Medium (confirmed) | "Try again" on a demo pin's failed job (`JobProgress.tsx:244`) calls `retry.start("<owner>/<repo>")`, which queues the default branch's head, not the pin; and `queuePin` (`lib/repoView.ts:654`) answers `unavailable` for every failed row but `QUEUE_UNAVAILABLE`, so a transient failure (`WORKER_ERROR`, `DOWNLOAD_FAILED`) after a version bump leaves the pin on its older graph until the database is fixed by hand | M9.7b |
| F2 | Medium (confirmed path) | `queuePin` asks GitHub (`resolveRepo`) before reading the stored row, with no `deps.heads` cache or hourly bound, so while a pin's job is in flight (or forever under F1) every permalink view costs a GitHub call; these are the landing's most-clicked links | M9.7b |
| F3 | Low (confirmed) | The pin's redirect to its progress page and the page's `home` drop the deep-link query, so the README GIF's link (`?open=…&trace=…`) lands on the plain permalink after the next version bump | M9.7b |
| F4 | Low-medium (confirmed, docs) | The blog post's "No env values, rewrites, or dev proxies" (`resolver-post.md:141`) is false: Next rewrites/`basePath` and Vite/CRA proxies are read (COVERAGE.md), and example env files' URL paths are (ADR-0202), as the post itself says at line 129 | M9.7c (a factual fix to Abhinav's draft, noted on #29) |
| G1 | High (confirmed) | A type annotation hides the base an SDK client was built with: `sdkOfDeclaration` (`sdk.ts:627`) returns the type's client before reading the initializer, and a client known only by its type (`unseen`) goes to the SDK's default host at `heuristic` (`sdk.ts:941–950`). `private openai: OpenAI` assigned `new OpenAI({ baseURL: "https://api.groq.com/openai/v1" })` in the constructor, or `const c: OpenAI = new OpenAI({ baseURL })`, draws `api.openai.com`: a wrong edge in ordinary TypeScript. M9.1a3e2a's test is JS (`src/llm.js`), so it never met an annotation; the demo pins are JS, so their records stand | M9.7d, red TS fixture first |
| G2 | Medium (confirmed by tracing) | Only the first branch's client is kept (`sdk.ts:748` for `??`/`||`/`&&`, `:756` for `?:`, `:718–723` for a factory's first `return`). Harmless before bases, but now `LOCAL ? new OpenAI({ baseURL: openrouter }) : new OpenAI()` draws only `openrouter.ai` at `exact`, dropping `api.openai.com` | M9.7d |
| G3 | Medium (plausible) | An SDK base from an env var named like an API base (`UPSTREAM_BASE_URL`) is matched against the repo's routes, and `urlPathPrefix` drops the example's host, so an OpenAI-compatible proxy whose handler calls upstream through `new OpenAI({ baseURL: process.env.UPSTREAM_BASE_URL })` (example `https://api.openai.com/v1`) can be matched to its own `POST /v1/chat/completions` | M9.7e, red test first |
| G4 | Low-medium (confirmed) | `envPrefixes` (`envExamples.ts:89`) returns `undefined`, never `[]`, for an example URL with no path, so `match.ts:552`'s `replaced > 0` arm (an example host replacing the code fallback's path, ADR-0202's M9.1a3a amendment) can't run; its test stubs `[]`, a value real code never produces | M9.7e |
| G5 | Low (confirmed) | The mock skip (`sdk.ts:938`) checks only the chain's last name, so `openai.chat.completions.create.mock.calls.at(-1)` is a request | M9.7d |
| G6 | Low (docs) | COVERAGE.md has no row for SDK base options and describes only M5C.7c's catch-all rule; `broken.ts`'s `reaches` comment describes only the hole rule; ADR-0202's M9.1a3a "stale example can land on a root catch-all" no longer holds after M9.1a3b | M9.7c |
| F5 | Low (confirmed) | When the HTTP stage fails, the SDK stage throws (`analyze.ts:505`) if any SDK request has a base, losing every SDK and external node, though detectors are meant to fail alone | M9.7d |
| F6 | Low (docs) | `docs/demos/README.md` records production at 0.3.0 (now 0.3.1, re-checked above by counts and sizes, not hashes), and `/privacy` says the download "is unpacked in memory" while `/how-it-works` (correctly) says it's written to the job's folder, and the per-repo fact cache isn't mentioned | M9.7c |
| F7 | Low (plausible) | `frameHop` (`camera.ts`) can clamp the zoom up past what fits above or left of the minimap on a tiny canvas, and its `best ?? centered` fallback isn't re-checked; `spreadLabels` (`image/layout.ts`) measures a line with `lengthAt(points, last)`, short for a route that revisits its end point | M9.7f, red tests first |
| F8 | Low (seen in the smoke test) | On the README GIF's link (taxonomy, trace open, 1280×800), "Tip 1 of 1" covers the top edge of the trace's `app` box at 32% in both themes (`smoke/readme-link-light.png`): the trace's whole-path frame doesn't keep below the card as the first view does (M9.2g) | M9.7f, red test first |

## Smoke test

Run as a signed-out user from the laptop against production (`https://gitinside.abhinavgonthina.dev`), 2026-11-11, at `9cc7c5a` (`apps/web/dist/m97a-smoke.mjs`, `m97a-browser.mjs`).

- **Pages:** landing, `/how-it-works`, `/limits`, `/privacy`, `/self-hosting` `200`, each with its heading; `/dashboard` `307` to sign-in; an unknown repo's page `200` with the not-analyzed screen.
- **Gallery:** 3 cards, each linking its pin's permalink, thumbnails `/api/diagram/<owner>/<repo>/<sha>.svg` drawn, counts "873 checked, 0 wrong", "29…", "142…" (`smoke/landing-dark.png`).
- **Permalinks in Chromium:** each laid out with no console errors: anything-llm 55 boxes (4.2 s), taxonomy 5, maxun 11 (`smoke/*-dark.png`). Their graphs (`/api/graph/…`, a `308` to the canonical URL) are `0.3.1`, with the checked inferred-edge counts (Results).
- **The README GIF's link:** taxonomy with `GET /api/users/stripe` traced, step 1 of 5 in the inspector with its code (`smoke/readme-link-*.png`; F8).
- **Images:** each pin's diagram SVG and badge `200` `image/svg+xml`.
- **A new analysis:** `vercel/nextjs-postgres-auth-starter` through `/api/analyze` (as the form posts it): `202` queued, `done` 11 s later; its graph `0.3.1`, 50 nodes, 24 edges.

## Interview questions

1. **Your eval says 100% precision. How did the demo check find 372 wrong edges?**
   (Batch 6 came later: 100.0%, 521 of 521.) The eval labels frontend requests to backend routes, so it can only catch a request matched to the wrong route. The demo check read every inferred edge, including SDK calls, catch-all 404 handlers, and bases from `.env.example`, which the eval never labels. Precision is only as wide as what's labeled; a second, differently shaped check found a different class of mistake.

2. **How do you stop production from serving a stale graph after you change the analyzer?**
   Graphs are cached by (repo, commit, analyzer version), so the version must move whenever output does. `version.test.ts` records a digest of every fixture's golden graph per version and fails when the output changes under the same one. Then the CDN: the graph URL carries `?v=<version>`, so a day-cached copy of the old version can't be served as the new one, and a pin's permalink queues the current version over an older graph.

3. **Why skip compose files in `fixtures/` instead of drawing them marked?**
   They describe nothing the repo runs, and the README image and the PR bot apply no viewer filters, so a mark would still draw them. Folder names, not file names, decide it, because a root `docker-compose.test.yml` is usually part of the real project.

4. **The worker retries a download without its token. Isn't that a hole?**
   Only the worker's own public token is dropped, only on a `403` that isn't a rate limit (an org's token policy refusing an outside token), and only once. Without a token GitHub serves only what's public, so nothing private becomes readable; an installation's token is never dropped.

5. **What would you fix first now?**
   Recall: batch 6's misses have 10 causes and one (a trimmed axios base) is 141 of 234. But fixing it makes batch 6 seen, so the next blind batch has to be drawn first to keep a number that says how the analyzer does on new code.

Quiz yourself: open Claude Code and say "quiz me on M9".
