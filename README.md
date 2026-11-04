# GitInside

**Git inside your repo.**

See how any codebase really works. Break it down from services to functions, trace every request, and catch broken connections before they ship.

(Status: in development. M1 (analyzer CLI), M2 (cross-service links + infra), M3 (accuracy eval harness), and M4a (design system + prototype, approved) are done; the interactive explorer (M4b, now drilling down to functions) and the website (M5, built and awaiting deploy) are in progress, and the PR bot comes next.)

## Quickstart (analyzer CLI)

GitInside builds the diagram from static analysis. It parses the repo and never installs or runs anything from it.

```sh
pnpm install
pnpm build
node packages/analyzer/dist/cli.js analyze path/to/repo --out architecture.json
```

The output is a schema-valid `architecture.json`, the same bytes every time for the same commit. It covers workspace services, modules, files, symbols, imports, calls, Express and Next.js routes, and Prisma models. It also links `fetch`/axios calls to the routes they hit, each with a confidence level (exact, pattern, heuristic). It adds external APIs (from literal hosts and allowlisted SDKs), docker-compose and `.env` datastores (key names and URL hosts only, never values), and BullMQ/Bull/Bee-Queue queues. Anything it can't resolve appears as an `unresolved` node or a warning, never a guess. Optional flags `--owner`, `--name`, and `--sha` record the repo identity.

**Supported size:** repos up to 20,000 source files and 50 MB of source code (the `.ts .tsx .js .jsx .mjs .cjs .prisma` files left after ignored, generated, and over-2 MB files), in the CLI and on the website. A bigger repo fails at once with `LIMIT_FILES` or `LIMIT_SOURCE_SIZE`, before any parsing. Under the website's caps (3 GB of memory, 5 minutes) on a 20-core laptop, cal.com (5,073 files, 18 MB, 113 services) took 38 s and a 59 MB VS Code folder 51 s, while VS Code itself (15,184 files, 201 MB) is refused 0.5 s into the analysis. A repo of many services can still run out of memory or time under 50 MB. [Report](bench/results/2026-10-31-capped-vscode.md), ADR-0137. For Cloud Run's 4 GiB instances the heap cap is now 2,560 MB (and 400 MB unpacked, 60,000 files and folders); cal.com and a 45 MB VS Code folder still finished under 2,048 MB. [Report](bench/results/2026-11-01-capped-memory.md), ADR-0146.

## Quickstart (website, local)

The website queues each analysis on Google Cloud Tasks, which pushes it to the worker's `POST /run`. Locally, without a Google project, the website can push jobs straight to a worker on your machine instead:

1. Start Postgres and migrate: `docker compose -f infra/docker-compose.dev.yml up -d`, then `pnpm --filter @gitinside/db migrate` with `DATABASE_URL=postgres://gitinside:gitinside@127.0.0.1:5432/gitinside`.
2. Create `apps/worker/.env.local` from [apps/worker/.env.example](apps/worker/.env.example): that `DATABASE_URL`, an `ENQUEUE_HMAC_SECRET` (32 random bytes, base64url: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), and the `SNAPSHOTS_*` of a bucket for development (never production's). Then `pnpm build` and `node --env-file=apps/worker/.env.local apps/worker/dist/bin.js` (listens on http://127.0.0.1:8080).
3. Create `apps/web/.env.local` from [apps/web/.env.example](apps/web/.env.example): the same `DATABASE_URL`, `ENQUEUE_HMAC_SECRET`, and `SNAPSHOTS_*`, `WORKER_URL=http://127.0.0.1:8080`, `LOCAL_TASKS=push`, and no `GCP_*` variable. Then `pnpm --filter @gitinside/web dev` and open http://localhost:3000.

Each job is signed and pushed as Cloud Tasks would push it, with its retries (3 attempts), one at a time; the dev server logs each delivery. This works only with a `localhost`, `127.0.0.1`, or `[::1]` worker and never on Vercel (ADR-0149).

## Comparing commits

To see what a change does to the architecture, diff two commits, folders, or graph files:

```sh
node packages/analyzer/dist/cli.js diff main my-branch --repo path/to/repo
node packages/analyzer/dist/cli.js diff main my-branch --repo path/to/repo --format mermaid
```

Commits are checked out into temporary `git worktree`s (no git hooks run) and removed afterwards. The JSON output lists added, removed, modified, and renamed nodes and edges, plus **broken connections**: calls whose route, function, file, or model field the change removed or changed while the caller still makes them. `--format mermaid` prints a flowchart of the services, routes, and models that changed, with broken connections first.

## Architecture

A pnpm + Turborepo monorepo:
- `packages/schema` holds the graph format and the graph diff format (types + Zod validators).
- `packages/diff` compares two graphs of a repo (M6, in progress): `diffGraphs` classifies nodes and edges by per-kind fingerprints, detects renames and moves, and finds broken connections; `applyDiff` rebuilds head from base + diff; `renderMermaidSummary` draws the change. Property-tested with fast-check.
- `packages/analyzer` holds the analysis pipeline and the `gitinside` CLI (`analyze`, and `diff`, which analyzes both sides and calls `packages/diff`) (inventory → workspaces → per-service TypeScript programs → detectors → validated graph).
- `packages/viewer` holds the explorer's React components and their Storybook (`pnpm --filter @gitinside/viewer storybook`).
- `packages/db` holds the Postgres schema (Drizzle), committed SQL migrations, and the client shared by the web app and worker. Local Postgres: `docker compose -f infra/docker-compose.dev.yml up -d`, then `pnpm --filter @gitinside/db migrate` with `DATABASE_URL` from that file. Its tests run on in-memory PGlite, so they need no Docker.
- `apps/web` is the website (Next.js App Router, built on the viewer's tokens and components): `pnpm build`, then `pnpm --filter @gitinside/web start` (or `dev`) and open http://localhost:3000. To analyze from the site locally, run the worker too ([Quickstart (website, local)](#quickstart-website-local)). Each analyzed repo's page has "Add to README", which gives the Markdown for a live badge or diagram image that stays current with the default branch.
- `infra/gcp` holds the production worker's reviewed Google Cloud config: the Cloud Run service (1 vCPU / 4 GiB, one job per instance, at most 2 instances, no public access), the Cloud Tasks queue (2 at once, 3 attempts), IAM, and CI's check of the worker image as Cloud Run runs it ([infra/gcp/README.md](infra/gcp/README.md)).
- `eval/` holds the accuracy eval (pinned repos, hand-written labels, scorer, committed reports).
- `bench/` holds benchmarks, and `fixtures/` holds golden test repos.

Design notes: [docs/DESIGN.md](docs/DESIGN.md). Milestone reviews: [M1](docs/milestones/M1-review.md), [M2](docs/milestones/M2-review.md), [M3](docs/milestones/M3-review.md). How cross-service links are resolved: [docs/walkthroughs/resolver.md](docs/walkthroughs/resolver.md).

## Results so far

Reported exactly as measured; each links to the committed report.

- **Analysis time (M1 baseline):** cal.com at a pinned SHA (5,041 files, 113 workspace packages) analyzes in a median of 53.3 s (range 27–77 s) with ~2 GiB peak memory on a dev laptop, and every run produces a byte-identical graph. [Report](bench/results/2026-10-26-analysis-calcom.md). Reproduce with `pnpm bench`.
- **Incremental analysis (M6):** with a fact cache, re-analyzing the same cal.com commit takes 4.4 s instead of 24.9 s (5.7×), and after a one-line edit to a leaf app 12.6 s instead of 35.6 s (2.8×). On 10 consecutive real cal.com commits the median speedup is **0.99×**, about even with no cache: nine of them touch files that 88 of the 113 services' programs read, so those services are analyzed again, and rewriting their entries costs 0.7–0.9 s (ADR-0181). Every cached run gave the same bytes as a cold one. Dev laptop, which slowed during the runs, so compare within a report. [Edits report](bench/results/2026-11-02-incremental-calcom-m6.8c2.md), [commits report](bench/results/2026-11-02-incremental-calcom-commits-m6.8c2.md) (earlier: M6.8's first measurements, [edits](bench/results/2026-11-02-incremental-calcom.md) and [commits](bench/results/2026-11-02-incremental-calcom-commits.md), 0.84×; after M6.8b, [edits](bench/results/2026-11-02-incremental-calcom-m6.8b.md) and [commits](bench/results/2026-11-02-incremental-calcom-commits-m6.8b.md), 0.91×; after M6.8c1, [edits](bench/results/2026-11-02-incremental-calcom-m6.8c.md) and [commits](bench/results/2026-11-02-incremental-calcom-commits-m6.8c.md), 0.94×). Reproduce with `pnpm bench:incremental` (add `-- --commits` for the replay).
- **Cross-service links (M2 smoke test, not yet an accuracy measure):** on the same cal.com commit, all 269 HTTP requests (from 217 call sites) reach the graph, none dropped. They form 38 `http` edges to routes (22 exact, 7 pattern, 9 heuristic), 135 edges to unresolved nodes that carry a reason, and 79 `external_call` edges. Allowlisted SDK calls bring `external_call` edges to 138, across 29 hosts. [M2 review](docs/milestones/M2-review.md#smoke-test).
- **Cross-service accuracy (M3, first run, pending owner review of the labels):** on 5 hand-labeled public repos (144 labels at 142 call sites), precision is 96.6% (28 of 29 predicted routes correct) and recall is 20.3% (28 of 138 real targets found). Recall is low mainly because WealthWise and foodie send every request through a helper that takes the path (`apiClient`, `httpRequest`), and the analyzer reports those requests once, unresolved, inside the helper instead of at each caller (83 of the 110 misses); most of wanderlust's calls get no prediction at all. Every miss is listed in the [report](eval/results/2026-10-30-0.1.0.md). Reproduce with `pnpm eval --check`. **After M5A:** precision 100.0% (138 of 138), recall 100.0% (138 of 138), after recall fixes for env fallbacks, object clients, axios configs and defaults, folder-loaded and class-held Express apps, sibling apps, fixed-route helpers, API-base env names, URLs chosen by a ternary or a `let`, and call sites anchored at the call's first line (ADR-0158 to ADR-0167, summed up in ADR-0168). All five repos are complete; 133 of the 138 links are `heuristic` (they cross services through an env-named base, a root-relative path, or a router loaded from a folder listing), 5 `exact`. These five are where the fixes were chosen, so they show the fixes work, not that they generalize. [Report](eval/results/2026-11-02-0.1.0.md).
- **Cross-service accuracy, held-out repos (M5A, first run, before any recall fix):** on 3 more hand-labeled repos, scored apart from the five above and never used to choose fixes (81 labels at 79 call sites), precision is 75.4% (43 of 57) and recall is 55.1% (43 of 78). mern-social's root-relative `fetch` calls are all found (18/18); online-ide gets no prediction at any of its 21 backend calls; in mern-ecommerce, 14 of 39 are reported at the Redux thunk that passes an `id` instead of at the request that fixes the path, which counts as 14 misses plus 14 wrong predictions. **After M5A:** precision 100.0% (78 of 78), recall 100.0% (78 of 78): all three are complete. No fix was chosen from these repos, but their misses were read during the last three fixes, so they now count as seen, not unseen (ADR-0168); a fresh batch is below. online-ide's 20 wrong predictions before M5A.3i were all the right route reported at the `.get(` line of a call split across lines. Three small repos (81 labels in all) are a small sample, so expect lower numbers on other codebases. [First-run report](https://github.com/AbhinavGonthina/gitinside/blob/1cdf2ec/eval/results/2026-11-01-0.1.0.md#held-out-repos) (at the commit that recorded it; later runs overwrote that file), [report after M5A](eval/results/2026-11-02-0.1.0.md#held-out-batch-1-seen).
- **Cross-service accuracy, held-out batch 2 (after M5A, unseen, first and only blind run):** on 2 Next.js pages-router + Prisma apps picked for URL styles none of the first eight has, labeled and committed before the analyzer first ran on them (33 labels at 32 call sites), precision is 45.8% (11 of 24) and recall is 35.5% (11 of 31). This is the number that says how well the M5A fixes generalize, and they don't fully: twitter-clone gets 11 of 18 (its 7 misses are SWR keys, `useSWR(url, fetcher)`, where the library, not the repo, calls the fetcher); nextjs-prisma-boilerplate gets 0 of 13 although every request is found with the right file and path, because its `next-connect` handlers (`handler.get(…)`) are read as accepting any method (`ALL`), so each counts as a wrong route and a miss. Both causes are written up in the [diagnosis](eval/results/2026-11-batch2-diagnosis.md) and not fixed in M5A. [Blind-run report](https://github.com/AbhinavGonthina/gitinside/blob/eee9e37/eval/results/2026-11-01-0.1.0.md#held-out-batch-2-unseen); the M5A review fixes left these counts unchanged ([report after M5A](eval/results/2026-11-02-0.1.0.md#held-out-batch-2-unseen)). **After M5B:** precision 100.0% (31 of 31), recall 100.0% (31 of 31), all 31 `exact`, after fixes for `next-connect` method registrations (recall 77.4%), SWR hooks calling the repo's fetcher (96.8%), and negated `req.method` tests (ADR-0191, ADR-0193, ADR-0195). Those fixes were chosen with batch 2's misses in view, so it now counts as seen and no longer measures generalization; that is a fresh blind batch's job (batch 3, next). [Report after M5B](eval/results/2026-11-03-0.1.0.md#held-out-batch-2-seen).

## Contributing setup

After cloning, install the git hooks once:

```sh
sh scripts/setup-hooks.sh        # macOS / Linux / Git Bash
```

```powershell
.\scripts\setup-hooks.ps1        # Windows PowerShell
```
