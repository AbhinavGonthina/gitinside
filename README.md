# GitInside

**Git inside your repo.**

See how any codebase really works. Break it down from services to functions, trace every request, and catch broken connections before they ship.

(Status: in development. M1 (analyzer CLI), M2 (cross-service links + infra), M3 (accuracy eval harness), and M4a (design system + prototype, awaiting design approval) are done; the website is in progress (M5), and the interactive explorer and PR bot come next.)

## Quickstart (analyzer CLI)

GitInside builds the diagram from static analysis. It parses the repo and never installs or runs anything from it.

```sh
pnpm install
pnpm build
node packages/analyzer/dist/cli.js analyze path/to/repo --out architecture.json
```

The output is a schema-valid `architecture.json`, the same bytes every time for the same commit. It covers workspace services, modules, files, symbols, imports, calls, Express and Next.js routes, and Prisma models. It also links `fetch`/axios calls to the routes they hit, each with a confidence level (exact, pattern, heuristic). It adds external APIs (from literal hosts and allowlisted SDKs), docker-compose and `.env` datastores (key names and URL hosts only, never values), and BullMQ/Bull/Bee-Queue queues. Anything it can't resolve appears as an `unresolved` node or a warning, never a guess. Optional flags `--owner`, `--name`, and `--sha` record the repo identity.

## Architecture

A pnpm + Turborepo monorepo:
- `packages/schema` holds the graph format and the graph diff format (types + Zod validators).
- `packages/diff` compares two graphs of a repo (M6, in progress: so far it checks that two graphs are comparable and applies a diff to its base).
- `packages/analyzer` holds the analysis pipeline and CLI (inventory → workspaces → per-service TypeScript programs → detectors → validated graph).
- `packages/viewer` holds the explorer's React components and their Storybook (`pnpm --filter @gitinside/viewer storybook`).
- `packages/db` holds the Postgres schema (Drizzle), committed SQL migrations, and the client shared by the web app and worker. Local Postgres: `docker compose -f infra/docker-compose.dev.yml up -d`, then `pnpm --filter @gitinside/db migrate` with `DATABASE_URL` from that file. Its tests run on in-memory PGlite, so they need no Docker.
- `apps/web` is the website (Next.js App Router, built on the viewer's tokens and components): `pnpm build`, then `pnpm --filter @gitinside/web start` (or `dev`) and open http://localhost:3000. Analysis from the site arrives with the worker (M5.4–M5.8). Each analyzed repo's page has "Add to README", which gives the Markdown for a live badge or diagram image that stays current with the default branch.
- `eval/` holds the accuracy eval (pinned repos, hand-written labels, scorer, committed reports).
- `bench/` holds benchmarks, and `fixtures/` holds golden test repos.

Design notes: [docs/DESIGN.md](docs/DESIGN.md). Milestone reviews: [M1](docs/milestones/M1-review.md), [M2](docs/milestones/M2-review.md), [M3](docs/milestones/M3-review.md). How cross-service links are resolved: [docs/walkthroughs/resolver.md](docs/walkthroughs/resolver.md).

## Results so far

Reported exactly as measured; each links to the committed report.

- **Analysis time (M1 baseline):** cal.com at a pinned SHA (5,041 files, 113 workspace packages) analyzes in a median of 53.3 s (range 27–77 s) with ~2 GiB peak memory on a dev laptop, and every run produces a byte-identical graph. [Report](bench/results/2026-10-26-analysis-calcom.md). Reproduce with `pnpm bench`.
- **Cross-service links (M2 smoke test, not yet an accuracy measure):** on the same cal.com commit, all 269 HTTP requests (from 217 call sites) reach the graph, none dropped. They form 38 `http` edges to routes (22 exact, 7 pattern, 9 heuristic), 135 edges to unresolved nodes that carry a reason, and 79 `external_call` edges. Allowlisted SDK calls bring `external_call` edges to 138, across 29 hosts. [M2 review](docs/milestones/M2-review.md#smoke-test).
- **Cross-service accuracy (M3, first run, pending owner review of the labels):** on 5 hand-labeled public repos (144 labels at 142 call sites), precision is 96.6% (28 of 29 predicted routes correct) and recall is 20.3% (28 of 138 real targets found). Recall is low mainly because WealthWise and foodie send every request through a helper that takes the path (`apiClient`, `httpRequest`), and the analyzer reports those requests once, unresolved, inside the helper instead of at each caller (83 of the 110 misses); most of wanderlust's calls get no prediction at all. Every miss is listed in the [report](eval/results/2026-10-29-0.1.0.md). Reproduce with `pnpm eval --check`.

## Contributing setup

After cloning, install the git hooks once:

```sh
sh scripts/setup-hooks.sh        # macOS / Linux / Git Bash
```

```powershell
.\scripts\setup-hooks.ps1        # Windows PowerShell
```
