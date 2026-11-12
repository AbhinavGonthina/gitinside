# Shared source files on 1 vCPU: calcom/cal.diy before and after ADR-0197 (M5.13a4a, 2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee` (5,075 source files, 113 services)
- **Before:** gitinside `bd5cfea` (branch `ci/m5.13a4a-before`), plus M5.13a3's report at `d47f463` (same analyzer code: only docs changed between them). **After:** gitinside `97ae155` (ADR-0197) and `4560e4d` (eval report only on top).
- **Method:** the "Benchmark (1 vCPU)" workflow (`.github/workflows/bench-cloudrun.yml`, M5.13a3) unchanged: the worker image built on the runner, 3 cold analyses per workflow run, each in a fresh `docker run --cpus 1 --memory 4g` container with `/tmp` in memory, through the image's extractor and sandboxed runner, no fact cache. 7 workflow runs before, 6 after, all dispatched on 2026-11-04 between 05:53 and 06:52 UTC.
- **Raw output:** each workflow run's artifact is committed unchanged next to this file as `2026-11-04-cloudrun-caldiy-m5.13a4a-<before|after>-<cpu>[-n].{md,json}`; M5.13a3's is `2026-11-04-cloudrun-caldiy.{md,json}`. The tables below are copied from them.

## Parses (local, analyzer build at `97ae155`)

Scratch script `bench/dist/m513a4-parses.mjs` (the analyzer's inventory, workspace, and `buildServicePrograms`, every program built, distinct `SourceFile` objects counted per repo path):

```json
{"services":113,"distinctFiles":5148,"loads":7636,"loadsPerFile":1.48,"parses":5577,"parsesPerFile":1.08,"filesParsedMoreThanOnce":313,"buildMs":6929,"mostParsed":[["packages/platform/constants/api.ts",3],["packages/platform/constants/apps.ts",3],["packages/platform/constants/permissions.ts",3],["packages/platform/constants/index.ts",3],["packages/platform/types/api.ts",3]],"heapMib":1088}
```

Before the change every load was a parse: 7,636 (1.48 per file, `2026-11-04-caldiy-stages.md`). A first version keyed by TypeScript's settings key as is (with `pathsBasePath`) gave 7,030 parses (1.37 per file); without it, 5,577 (ADR-0197).

## Memory (every run)

| | Runs | Final heap (child) | Peak RSS (child) | Container memory peak |
|---|---:|---:|---:|---:|
| Before (`bd5cfea`) | 18 | 1,975–1,985 MiB | 2,111–2,123 MiB | 2,394–2,413 MiB |
| Before (`d47f463`, M5.13a3) | 3 | 1,974–1,979 MiB | 2,110–2,115 MiB | 2,393–2,406 MiB |
| After (`97ae155`) | 18 | 1,802–1,808 MiB | 1,938–1,972 MiB | 2,217–2,255 MiB |

Graphs: the same SHA-256 (`041b1f48bdf8…`) in all 39 runs, before and after.

## Time, by runner CPU model

GitHub's runners came on five CPU models. Only models measured both before and after are compared; each row is one workflow run (one runner, 3 analyses).

| CPU | Version | Workflow run | Analysis (3 runs) | `programs` (3 runs) |
|---|---|---|---|---|
| AMD EPYC 7763 | before | [41787818070](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787818070) | 57.3, 57.7, 56.3 s | 15.5, 15.7, 15.5 s |
| AMD EPYC 7763 | before | [41787825061](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787825061) | 57.2, 57.5, 57.7 s | 15.8, 15.4, 15.4 s |
| AMD EPYC 7763 | after | [41787121067](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787121067) | 56.3, 55.9, 57.0 s | 14.8, 14.9, 14.8 s |
| AMD EPYC 7763 | after | [41787124090](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787124090) | 55.1, 55.6, 55.6 s | 14.4, 14.7, 14.6 s |
| AMD EPYC 7763 | after | [41787127200](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787127200) | 54.8, 55.4, 55.5 s | 14.4, 14.4, 14.3 s |
| AMD EPYC 7763 | after | [41787831618](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787831618) | 53.7, 53.7, 53.7 s | 13.6, 14.0, 13.8 s |
| AMD EPYC 9V74 | before | [41787821608](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787821608) | 44.4, 45.1, 44.4 s | 11.8, 12.1, 11.8 s |
| AMD EPYC 9V74 | after | [41787834871](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787834871) | 43.3, 43.4, 43.3 s | 11.3, 11.2, 10.9 s |
| Intel Xeon Platinum 8573C | before (M5.13a3) | [41781984308](https://github.com/AbhinavGonthina/gitinside/actions/runs/41781984308) | 44.4, 44.3, 44.2 s | 11.9, 12.0, 12.1 s |
| Intel Xeon Platinum 8573C | after | [41787828410](https://github.com/AbhinavGonthina/gitinside/actions/runs/41787828410) | 52.6, 52.3, 52.0 s | 14.2, 13.9, 13.6 s |

Measured only before: AMD EPYC 9V45 (runs [41783450784](https://github.com/AbhinavGonthina/gitinside/actions/runs/41783450784): 35.7, 35.8, 35.6 s, and [41785019967](https://github.com/AbhinavGonthina/gitinside/actions/runs/41785019967): 41.9, 40.4, 40.2 s) and Intel Xeon Platinum 8370C ([41785016038](https://github.com/AbhinavGonthina/gitinside/actions/runs/41785016038): 58.1, 58.9, 58.5 s).

Medians where both exist: EPYC 7763 57.4 s → 55.5 s (`programs` 15.5 → 14.4 s); EPYC 9V74 44.4 s → 43.3 s (11.8 → 11.2 s); Xeon 8573C 44.3 s → 52.3 s (12.0 → 13.9 s).

## Observations (hand-written, not generated)

- **Memory is the clear result.** The child's final heap went from 1,975–1,985 MiB to 1,802–1,808 MiB (about −173 MiB, −8.8%) and the container's peak from 2,394–2,413 MiB to 2,217–2,255 MiB, in every one of the 18 runs after, on every CPU model. Each run repeats to within ~10 MiB, so this isn't noise. The heap is now 74% of the 2,560 MB (2,441 MiB) cap, from 81%.
- **The output is unchanged:** one graph hash across all 39 runs, as locally (goldens, determinism, warm == cold, and `pnpm eval` with no delta in any set).
- **Time can't be called from these runs.** On two models the change measured faster (EPYC 7763 by 1.9 s, 3%; EPYC 9V74 by 1.1 s, 2.5%; `programs` down 0.6–1.1 s on both). On the Xeon 8573C it measured 8 s slower, but that "before" is a different runner an hour earlier. Runners of one model differ by more than that: the two EPYC 9V45 runners, same code, took 35.7 s and 40.4 s (13% apart), while 3 runs on one runner agree to within 0.2–1.7 s. M5.13a3 said this workflow could measure a change of a second or two; that holds only within one runner, and before and after never share one.
- **Why the time gain is small next to the parse count.** 27% fewer parses only touch the part of `programs` that is parsing. The rest is module resolution (each program still resolves every specifier itself, M5.13a4b) and building the programs' file lists. Binding happens at each checker's first use in the later stages, and a shared file is now bound once for all the programs that share it, but `calls` (the largest of those stages) didn't move on the models compared.
- **What would make time measurable:** one workflow run that builds both commits' images on the same runner and alternates them, so runner differences cancel. That's a change to the workflow, not to this task; worth doing before M5.13a4b and M5.13a5 if they're to be judged on time. Until then, compare heap (deterministic to ~10 MiB) and judge time only within one runner.
