# GitInside

[![Architecture of AbhinavGonthina/gitinside, by GitInside](https://gitinside.abhinavgonthina.dev/api/badge/AbhinavGonthina/gitinside.svg)](https://gitinside.abhinavgonthina.dev/AbhinavGonthina/gitinside)

**Git inside your repo.**

See how any codebase really works. Break it down from services to functions, trace every request, and catch broken connections before they ship.

<a href="https://gitinside.abhinavgonthina.dev/shadcn-ui/taxonomy/298a8857c7128a0d121e7f699dfd729f23b3966d?open=service:taxonomy/&trace=route:taxonomy/GET%20/api/users/stripe">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/trace.gif">
    <img alt="Trace mode on shadcn-ui/taxonomy: the Next.js service is broken down, T opens the picker, typing &quot;stripe&quot; finds GET /api/users/stripe, the app folder is broken down so the first step reads up close, and Play walks its five steps (the route's handler, getUserSubscriptionPlan, its Prisma read of User, MySQL, and the Stripe API) with each step's code beside the diagram" src="docs/media/trace-light.gif" width="960">
  </picture>
</a>

*Trace mode on [shadcn-ui/taxonomy](https://gitinside.abhinavgonthina.dev/shadcn-ui/taxonomy/298a8857c7128a0d121e7f699dfd729f23b3966d), recorded on the live site: one request's path from its route to the database and Stripe, step by step, with the code of each step.*

## What it is

Paste a GitHub repo's URL (or sign in for a private one) and GitInside draws its architecture: the services of a monorepo, their folders, files, and functions, the pages and routes, the database models, and the outside APIs, with every request from a frontend matched to the backend route it hits. You break any box down to see what's inside, and trace a request from its route to the database.

The diagram comes from **static analysis, never an LLM's guess**:
- **Parsed, never run.** GitInside reads the code with the TypeScript compiler. It never installs or runs anything from the repo ([docs/SECURITY.md](docs/SECURITY.md)).
- **Deterministic.** The same commit always gives the same graph, byte for byte.
- **Visible failures.** A request whose URL can't be worked out is drawn as unresolved, with the reason, rather than dropped or guessed.

It has four parts:
1. **The website**, [gitinside.abhinavgonthina.dev](https://gitinside.abhinavgonthina.dev): public repos with no sign-in, private ones through the GitHub App.
2. **A live README diagram:** a badge (like the one above) or the full diagram image, kept current with the default branch.
3. **A PR bot:** the GitHub App comments each pull request's architecture diff and flags the connections it breaks, such as a request whose route the PR removed.
4. **The explorer:** the dark-first, keyboard-driven canvas in the GIF.

v1 reads TypeScript and JavaScript: React and Next.js, Express and Next.js API routes, Prisma, docker-compose and `.env`, and workspace monorepos, up to 20,000 source files. What each detector does and doesn't handle is in [docs/COVERAGE.md](docs/COVERAGE.md).

**Status:** every milestone through the PR bot (M8) is done, and the launch work (M9) is in progress. The site is live, but nothing has been announced publicly yet.

## Why I built this

**PRs are slow to review because the flow is hard to see.** In my Software Design and Delivery class, we discussed how to make PRs as easy to review as possible. One thing I noticed: reviewers spend much of their time just working out where a piece of code fits into the overall flow. The bigger the project, the longer that takes, and for someone more junior it can be genuinely confusing. System design charts could help, but they rarely go into the fine-grained detail a reviewer actually needs.

**A Figma-like view of the flow helped me learn a codebase.** During my co-op at Philips, I collaborated with other teams, such as the UI/UX team, who had our app's whole flow laid out in Figma. I loved that. Figma's interface is very intuitive for me, and that kind of environment really helped me understand the codebase at the time.

Bringing those together: a simple interface, similar to Figma's designs with their details, but with the level of interactivity someone new to a codebase needs. That's GitInside.

## Try it

- **On the website:** open [gitinside.abhinavgonthina.dev](https://gitinside.abhinavgonthina.dev) and paste a public repo's URL. A progress page shows the analysis stages, then the diagram opens. Three demo repos, each checked edge by edge (see [Results](#demo-repos-checked-by-hand)), open at once: [Mintplex-Labs/anything-llm](https://gitinside.abhinavgonthina.dev/Mintplex-Labs/anything-llm/308b27662b2f6fd4947791d61c797945c609fcbc), [shadcn-ui/taxonomy](https://gitinside.abhinavgonthina.dev/shadcn-ui/taxonomy/298a8857c7128a0d121e7f699dfd729f23b3966d), and [getmaxun/maxun](https://gitinside.abhinavgonthina.dev/getmaxun/maxun/99c6bd0d42b14336b706ba121a3757f62a9814f7).
- **In the explorer:** double-click a box (or press Enter) to break it down, press T to trace a page or route, Ctrl+K to search, and Esc to go back up. Share gives a link to what's on screen (what's broken down, the selection, the trace step, the filters) at that commit.
- **In your README:** on a repo's page, "Add to README" gives the Markdown for its live badge or diagram image.
- **On your pull requests:** sign in, then install the GitHub App on your repos from the dashboard. Each PR then gets a `GitInside` check and a comment with the architecture diff and any broken connections.

## Quickstart (analyzer CLI)

The CLI runs the same analysis on a folder on your machine:

```sh
pnpm install
pnpm build
node packages/analyzer/dist/cli.js analyze path/to/repo --out architecture.json
```

The output is a schema-valid `architecture.json`, the same bytes every time for the same commit ([docs/GRAPH_SCHEMA.md](docs/GRAPH_SCHEMA.md)). It covers workspace services, modules, files, symbols, imports, calls, Express and Next.js routes, and Prisma models. It also links `fetch`/axios calls to the routes they hit, each with a confidence level (exact, pattern, heuristic). It adds external APIs (from literal hosts and allowlisted SDKs), docker-compose and `.env` datastores (key names and URL hosts only, never values), and BullMQ/Bull/Bee-Queue queues. Anything it can't resolve appears as an `unresolved` node or a warning, never a guess. Optional flags `--owner`, `--name`, and `--sha` record the repo identity.

**Supported size:** repos up to 20,000 source files and 50 MB of source code (the `.ts .tsx .js .jsx .mjs .cjs .prisma` files left after ignored, generated, and over-2 MB files), in the CLI and on the website. A bigger repo fails at once with `LIMIT_FILES` or `LIMIT_SOURCE_SIZE`, before any parsing. The website's worker runs each analysis on 1 vCPU and 4 GiB (a 2,560 MB heap, 400 MB unpacked, 60,000 files and folders) within 5 minutes, so a repo of many services can still run out of memory or time under 50 MB ([report](bench/results/2026-11-01-capped-memory.md), ADR-0137, ADR-0146).

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

```mermaid
flowchart LR
  U["Browser"] --> W
  subgraph Vercel["Vercel"]
    W["apps/web (Next.js)<br/>pages, API routes,<br/>App webhooks"]
  end
  subgraph Google["Google Cloud"]
    Q[("Cloud Tasks<br/>2 at once, 3 attempts")]
    K["apps/worker on Cloud Run<br/>one job per request"]
    C["analyzer child process<br/>no network, no env"]
  end
  PG[("Neon Postgres<br/>jobs, repos, progress")]
  S3[("Oracle Object Storage<br/>graph snapshots")]
  GH["GitHub<br/>API, tarballs, webhooks"]

  W -->|"signed job"| Q -->|"push"| K --> C
  K -->|"download tarball"| GH
  K -->|"gzipped graph"| S3
  K -->|"progress, result"| PG
  W --> PG
  W -->|"read graph"| S3
  GH -->|"PR webhooks"| W
  W -->|"comment + Check Run"| GH
```

The website never parses a repo. It records a job in Postgres and queues it on Cloud Tasks, which pushes it to the worker. The worker downloads the commit's tarball, extracts it with path checks, and runs the analyzer in a child process locked down by Node's permission model, with an empty environment and no network. It then stores the graph and reports progress through the job's row, which the progress page streams. Everything runs on free tiers. [docs/DESIGN.md](docs/DESIGN.md) has the details, and [docs/SECURITY.md](docs/SECURITY.md) the threat model.

Inside the analyzer, one pass over a checkout:

```
inventory → workspaces → per-service TypeScript programs → symbols, imports, calls
  → detectors (routes, Prisma, HTTP calls, SDKs, compose/.env, queues)
  → match each request's URL to a route → validated, canonically sorted graph
```

The code is a pnpm + Turborepo monorepo:
- `packages/schema` holds the graph format and the graph diff format (types + Zod validators).
- `packages/diff` compares two graphs of a repo: `diffGraphs` classifies nodes and edges by per-kind fingerprints, detects renames and moves, and finds broken connections; `applyDiff` rebuilds head from base + diff; `renderMermaidSummary` draws the change. Property-tested with fast-check.
- `packages/analyzer` holds the analysis pipeline and the `gitinside` CLI (`analyze`, and `diff`, which analyzes both sides and calls `packages/diff`) (inventory → workspaces → per-service TypeScript programs → detectors → validated graph).
- `packages/viewer` holds the explorer's React components and their Storybook (`pnpm --filter @gitinside/viewer storybook`).
- `packages/db` holds the Postgres schema (Drizzle), committed SQL migrations, and the client shared by the web app and worker. Local Postgres: `docker compose -f infra/docker-compose.dev.yml up -d`, then `pnpm --filter @gitinside/db migrate` with `DATABASE_URL` from that file. Its tests run on in-memory PGlite, so they need no Docker.
- `apps/web` is the website (Next.js App Router, built on the viewer's tokens and components): `pnpm build`, then `pnpm --filter @gitinside/web start` (or `dev`) and open http://localhost:3000. To analyze from the site locally, run the worker too ([Quickstart (website, local)](#quickstart-website-local)). Each analyzed repo's page has "Add to README", which gives the Markdown for a live badge or diagram image that stays current with the default branch.
- `infra/gcp` holds the production worker's reviewed Google Cloud config: the Cloud Run service (1 vCPU / 4 GiB, one job per instance, at most 2 instances, no public access), the Cloud Tasks queue (2 at once, 3 attempts), IAM, and CI's check of the worker image as Cloud Run runs it ([infra/gcp/README.md](infra/gcp/README.md)).
- `eval/` holds the accuracy eval (pinned repos, hand-written labels, scorer, committed reports).
- `bench/` holds benchmarks, and `fixtures/` holds golden test repos.

Design notes: [docs/DESIGN.md](docs/DESIGN.md). Decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Milestone reviews: [docs/milestones](docs/milestones). How cross-service links are resolved: [docs/walkthroughs/resolver.md](docs/walkthroughs/resolver.md). How two commits' graphs are diffed and broken connections found: [docs/walkthroughs/diff.md](docs/walkthroughs/diff.md).

## Results

Reported exactly as measured, each linking its committed report. The accuracy labels were drafted by Claude from each repo's code, never from analyzer output. Abhinav's review of a seeded random 20% of them isn't done yet, so the accuracy numbers may change.

### Accuracy on unseen repos (held-out batch 6)

This is the launch analyzer (0.3.0), scored once, blind. The 16 public React/Next + Express/Next repos were drawn at random by a rule committed before any candidate was seen (ADR-0208's M9.2a1 amendment). Every repo read for earlier batches, fixes, the PR backtest, or the demo checks was excluded before the draw. The labels were committed before the analyzer first ran on them: 790 labels at 783 call sites, 755 with a route.

- **Precision 100.0% (521 of 521)**, above the 95% floor. No predicted route is wrong (`exact` 312, `heuristic` 209), and all 35 labels with no route in the repo got no route.
- **Recall 69.0% (521 of 755)**, below the 80% target. 6 of the 16 repos (37.5%) are mapped completely.
- **The misses:** every labeled route is in the graph, so all 234 misses are on the calling side, each shown as unresolved with a reason or as nothing at the labeled call. They have 10 causes. One dominates: an axios base trimmed with `.replace(/\/+$/, "")` isn't read, which leaves 141 of one repo's 144 requests unresolved; without that repo, recall is 84.8% (518 of 611). The next largest are a test's `let baseUrl` first set inside a `listen(0)` callback (23), an RTK base spelled `window.location.protocol + "//" + window.location.host` (21), and a base held in a constructor parameter's default (12). None is fixed, so batch 6 stays unseen.

[Report](eval/results/2026-11-10-0.3.0.md#held-out-batch-6-unseen) (recorded at [`1bb2549`](https://github.com/AbhinavGonthina/gitinside/blob/1bb2549/eval/results/2026-11-10-0.3.0.md#held-out-batch-6-unseen)), [diagnosis](eval/results/2026-11-batch6-diagnosis.md). Reproduce with `pnpm eval --check`.

### Earlier batches

Each earlier set was scored once before any fix was chosen from it. The analyzer was then fixed from its misses, so it counts as seen from then on: its later numbers show that those fixes work, not that they generalize. Only the first run of each says how the analyzer of its day did on code it hadn't been tuned for.

| Set | Repos | Labels (with a route) | First run | First-run precision | First-run recall | Precision at 0.3.0 | Recall at 0.3.0 | Mapped completely at 0.3.0 |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| Original five (M3), where the first fixes were chosen | 5 | 144 (138) | [2026-10-30](eval/results/2026-10-30-0.1.0.md) | 96.6% (28/29) | 20.3% (28/138) | 100.0% (138/138) | 100.0% (138/138) | 5 of 5 |
| Batch 1 | 3 | 81 (78) | [2026-11-01](https://github.com/AbhinavGonthina/gitinside/blob/1cdf2ec/eval/results/2026-11-01-0.1.0.md#held-out-repos) | 75.4% (43/57) | 55.1% (43/78) | 100.0% (78/78) | 100.0% (78/78) | 3 of 3 |
| Batch 2 | 2 | 33 (31) | [2026-11-01](https://github.com/AbhinavGonthina/gitinside/blob/eee9e37/eval/results/2026-11-01-0.1.0.md#held-out-batch-2-unseen) | 45.8% (11/24) | 35.5% (11/31) | 100.0% (31/31) | 100.0% (31/31) | 2 of 2 |
| Batch 3 | 2 | 72 (70) | [2026-11-03](https://github.com/AbhinavGonthina/gitinside/blob/08caa77/eval/results/2026-11-03-0.1.0.md#held-out-batch-3-unseen) | 100.0% (45/45) | 64.3% (45/70) | 100.0% (70/70) | 100.0% (70/70) | 2 of 2 |
| Batch 4 | 16 | 397 (360) | [2026-11-04](https://github.com/AbhinavGonthina/gitinside/blob/bb6c94d/eval/results/2026-11-04-0.2.0.md#held-out-batch-4-unseen) | 94.4% (184/195) | 51.1% (184/360) | 100.0% (247/247) | 68.6% (247/360) | 9 of 16 |
| Batch 5 | 16 | 520 (460) | [2026-11-05](https://github.com/AbhinavGonthina/gitinside/blob/fe17b6d/eval/results/2026-11-05-0.2.0.md#held-out-batch-5-unseen) | 93.5% (290/310) | 63.0% (290/460) | 100.0% (396/396) | 86.1% (396/460) | 9 of 16 |

Batches 4, 5, and 6 were drawn at random by the same rule (the same strata and search queries), 16 repos each. Their blind runs went from 94.4% to 93.5% to 100.0% precision and from 51.1% to 63.0% to 69.0% recall, with 6 of 16 repos mapped completely each time. Batches 1–3 were picked by hand (batches 2 and 3 for request styles the earlier repos lacked) and are too small to say much alone. Every set's misses at 0.3.1 are in the [current report](eval/results/2026-11-11-0.3.1.md) (0.3.1 only stopped reading test folders' compose and env files, so every score is 0.3.0's), the first runs' causes in the diagnoses ([original five](eval/results/2026-11-recall-diagnosis.md), [batch 2](eval/results/2026-11-batch2-diagnosis.md), [3](eval/results/2026-11-batch3-diagnosis.md), [4](eval/results/2026-11-batch4-diagnosis.md), [5](eval/results/2026-11-batch5-diagnosis.md)), and each fix's eval delta in its commit and ADR ([docs/DECISIONS.md](docs/DECISIONS.md)).

### Demo repos, checked by hand

The three repos the landing page shows (Mintplex-Labs/anything-llm, shadcn-ui/taxonomy, getmaxun/maxun) are each pinned to one commit. Each of their 1,044 inferred edges (`http`, `external_call`, Prisma reads, writes, and stores) was read against the code there: 779 correct, **0 wrong**, and 265 unresolved with a reason. Getting there took fixes: the check found 372 wrong edges in anything-llm (244 + 11 + 117), each fixed in the analyzer and rechecked. So these repos show the zero-wrong bar met where it was worked for, not how often it holds elsewhere. Each pin's production graph is byte-identical to a local analysis at the same version. [docs/demos](docs/demos/README.md).

### PR backtest (M7)

Replaying all 926 merged PRs (of 1,004 merged; 77 past a 300-per-repo cap, 1 dropped by a force-push) of 7 public apps from 2026-07-01 to 2026-09-30 at analyzer 0.2.0, GitInside flagged 5 broken edges, all in one PR (getmaxun/maxun#1157, which emptied a file whose class 4 others still call). All 5 are function calls inside one service; **no cross-service (`http`) break was flagged in any PR**. Claude drafted all 5 as true breaks (0 reviewed by Abhinav yet), and a direct push fixed all 5 about 55 minutes later. This isn't a blind result: the first replay flagged nothing, a hand check of 38 PRs found #1157, and the detector gained the rule that flags it before the re-run. Recall isn't measured. [Report](eval/backtest/results/2026-11-07.md), with every limitation. Reproduce with `pnpm --filter @gitinside/eval backtest:report --check`.

### Benchmarks (launch analyzer 0.3.0)

- **Full analysis, as production runs it:** calcom/cal.diy at `2eb48ec` (5,075 files) in the worker image on 1 vCPU and 4 GiB, with production's limits and no cache, took a median of **49.4 s** on an AMD EPYC 9V74 runner and **42.3 s** on an EPYC 9V45, within the 60 s target for a 5k-file repo. The container peaked at 2,187–2,370 MiB of its 4 GiB. That is 16% and 26% slower than 0.2.0 on the same CPU models, mostly in the `imports` and `http` stages; the cause hasn't been looked for. [9V74 report](bench/results/2026-11-11-cloudrun-caldiy-m9.2d-epyc9v74.md), [9V45 report](bench/results/2026-11-11-cloudrun-caldiy-m9.2d-epyc9v45.md), from the "Benchmark (1 vCPU)" workflow.
- **On the dev laptop:** cal.com at a pinned SHA (5,073 files, 114 services) took a median of 110.7 s (106.5–112.6 s), and every run wrote the same graph. The laptop ran about 3× slower than it can for most of that session, so its seconds don't compare across reports. [Report](bench/results/2026-11-10-analysis-calcom.md). Reproduce with `pnpm bench`.
- **Incremental analysis:** with the fact cache, cold ÷ warm on cal.com (medians of pairs) is 16.8× with nothing changed, 4.28× after a one-line edit to a leaf app, and 1.03× after one to a shared package (89 services collected again). Over 10 consecutive real commits the median is **1.02×** (0.31× to 11.90×), about even with no cache: seven of the nine commits that change source re-collect 89–90 services, as a shared-package edit does. Every warm graph is its cold pair's bytes. [Edits report](bench/results/2026-11-10-incremental-calcom.md), [commits report](bench/results/2026-11-10-incremental-calcom-commits.md). Reproduce with `pnpm bench:incremental` (add `-- --commits` for the replay).
- **Rendering:** the explorer pans and zooms at 59.9 fps median (59.5 fps p5) at 500, 1,000, and 2,000 visible nodes, on a synthetic graph and on cal.com's, in headless Chromium on the laptop. That is the display's ceiling, so it shows the 60 fps target met, not the headroom. [Report](bench/results/2026-11-10-render.md). Reproduce with `pnpm bench:render`.

Earlier benchmark reports (the M1 baseline, M6's incremental runs, the stress test) are listed in [docs/EVALUATION.md §2](docs/EVALUATION.md#2-benchmarks).

## Contributing setup

After cloning, install the git hooks once:

```sh
sh scripts/setup-hooks.sh        # macOS / Linux / Git Bash
```

```powershell
.\scripts\setup-hooks.ps1        # Windows PowerShell
```
