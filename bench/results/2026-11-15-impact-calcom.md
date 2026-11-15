# Impact analysis benchmark: calcom

- Date: 2026-11-15
- Repo: [calcom](https://github.com/calcom/cal.com) at `0f19cc46ef6b6426ee398c670575b3c96be7af9e` (19,422 nodes, 31,769 edges)
- GitInside: `002d921fd996e4e4fc0ed685b463da7a2fa0780c`, analyzer 0.3.10
- Machine: dev machine, 13th Gen Intel(R) Core(TM) i7-13700H (20 cores), 15.6 GiB, win32 10.0.26300, Node v22.13.0
- Method: `impactIndex` built 5 times; `impactOf` on 1,118 targets, 3 runs each (median kept), after one warm-up pass. Node runs the same V8 engine as Chromium, but a visitor's machine may be slower than this one.

## Summary

| | median | p95 | max |
|---|---|---|---|
| Index build | 48.36 ms | | 53.66 ms |
| One query | 0.27 ms | 2.11 ms | 28.53 ms |

Budget: a first question (index build + query) within 100 ms. Worst case measured: 76.89 ms (median build + slowest query), **within budget**.

## Slowest targets

| Target | Kind | Time | Dependents | May also reach |
|---|---|---|---|---|
| `route:web/GET /api/link` | route | 28.53 ms | 0 | 363 |
| `service:app-store/` | service | 20.92 ms | 2,350 | 224 |
| `route:web/ALL /api/trpc/travelSchedules/:trpc` | route | 18.73 ms | 0 | 363 |
| `service:features/` | service | 8.96 ms | 2,520 | 255 |
| `service:lib/` | service | 8.91 ms | 4,982 | 196 |
| `service:atoms/` | service | 7.49 ms | 2,720 | 0 |
| `file:features/tasker/tasker-factory.ts` | file | 7.31 ms | 1,558 | 0 |
| `file:features/form-builder/schema.ts` | file | 5.56 ms | 1,816 | 0 |
| `service:constants/` | service | 5.34 ms | 2,488 | 0 |
| `route:web/ALL /api/trpc/loggedInViewerRouter/:trpc` | route | 5.23 ms | 0 | 363 |

## By kind

| Kind | Targets | Median | Max | Most dependents |
|---|---|---|---|---|
| datastore | 6 | 0.31 ms | 3.15 ms | 2,224 |
| external | 32 | 0.41 ms | 1.57 ms | 76 |
| file | 203 | 0.31 ms | 7.31 ms | 2,122 |
| model | 103 | 0.53 ms | 3.94 ms | 418 |
| page | 97 | 0.29 ms | 2.50 ms | 0 |
| route | 91 | 0.51 ms | 28.53 ms | 21 |
| service | 114 | 1.16 ms | 20.92 ms | 5,008 |
| symbol | 472 | 0.13 ms | 1.39 ms | 276 |

## Observations

- The first engine (commit `ed6a2c7`, string sets and maps, a sorted frontier per hop, three full walks) measured 109.93 ms median index build and 101.99 ms for its slowest query (`service:features/`), 211.92 ms worst first question, over budget: [report](2026-11-15-impact-calcom-first.md). This run's engine numbers nodes in ID order and keeps each node's incoming edges in typed arrays sorted by confidence (ADR-0298).
- The slowest rows are one-off pauses rather than big answers: `route:web/GET /api/link` (no dependents, 363 that may reach it) took 28.53 ms here, while the run before on the same code (`002d921`, not kept: it ran with an earlier report untracked in the tree) had every route at 0.73 ms or less and its slowest query at 18.78 ms (`service:app-store/`). This laptop's timings vary run to run (EVALUATION.md §2); the budget holds in both runs.
- The slowest build (53.66 ms) plus the slowest query is 82.19 ms, also within budget. Not measured: a fully cold first build and query (the benchmark builds the index once untimed and runs a warm-up pass before timing), which a visitor's first click pays.
