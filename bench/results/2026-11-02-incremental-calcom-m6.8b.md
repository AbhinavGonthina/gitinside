# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `cf0ed1f2a240c3471399e6502d62d367433223d3`)
- **Method:** 1 cold warm-up run, then one cold run filling a disk fact cache (`openDiskCache`) from the unedited tree. Each case then makes 5 pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 37,540 ms, 113 entries written, 25 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| Nothing changed | none | 35,129 ms (34,404 ms to 38,092 ms) | 8,740 ms (8,416 ms to 9,490 ms) | 25% | 113 | 0 | yes |
| One leaf app edited | `apps/api/v2/src/main.ts` | 38,691 ms (37,764 ms to 40,068 ms) | 17,072 ms (14,967 ms to 19,136 ms) | 44% | 112 | 1 | yes |
| A shared package edited | `packages/lib/constants.ts` | 35,342 ms (35,104 ms to 36,056 ms) | 38,465 ms (38,161 ms to 39,213 ms) | 109% | 112 | 88 | yes |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| Nothing changed | 2310 MiB (2303 MiB to 2315 MiB) | 576 MiB (555 MiB to 584 MiB) |
| One leaf app edited | 2309 MiB (2244 MiB to 2315 MiB) | 1037 MiB (955 MiB to 1045 MiB) |
| A shared package edited | 2305 MiB (2074 MiB to 2314 MiB) | 2304 MiB (2043 MiB to 2395 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | Nothing changed: cold | Nothing changed: warm | One leaf app edited: cold | One leaf app edited: warm | A shared package edited: cold | A shared package edited: warm |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 3,187 ms | 3,210 ms | 3,848 ms | 4,149 ms | 3,432 ms | 3,203 ms |
| workspace | 27 ms | 28 ms | 33 ms | 31 ms | 29 ms | 29 ms |
| programs | 12,261 ms | 2,119 ms | 13,325 ms | 3,953 ms | 12,042 ms | 13,507 ms |
| imports | 2,104 ms | 26 ms | 2,176 ms | 215 ms | 1,998 ms | 1,997 ms |
| express | 41 ms | 2 ms | 43 ms | 9 ms | 42 ms | 39 ms |
| next | 715 ms | 0 ms | 744 ms | 1 ms | 713 ms | 636 ms |
| prisma | 1,211 ms | 19 ms | 1,260 ms | 406 ms | 1,175 ms | 1,195 ms |
| infra | 36 ms | 33 ms | 38 ms | 40 ms | 36 ms | 34 ms |
| files | 2,911 ms | 3,022 ms | 3,409 ms | 3,316 ms | 2,908 ms | 2,712 ms |
| symbols | 57 ms | 0 ms | 57 ms | 11 ms | 53 ms | 51 ms |
| calls | 4,924 ms | 13 ms | 5,178 ms | 3,130 ms | 4,838 ms | 5,130 ms |
| http | 4,014 ms | 14 ms | 4,427 ms | 674 ms | 4,127 ms | 4,110 ms |
| sdk | 1,365 ms | 1 ms | 1,497 ms | 216 ms | 1,332 ms | 1,348 ms |
| queues | 2,126 ms | 0 ms | 2,275 ms | 357 ms | 2,109 ms | 1,998 ms |
| assemble | 325 ms | 273 ms | 342 ms | 311 ms | 318 ms | 341 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **What changed since M6.8's report** (`2026-11-02-incremental-calcom.md`, gitinside `681a893`): only how cache entries are stored and checked (gitinside `f10e015`, ADR-0179; `cf0ed1f` after it only re-records the eval report); same cases, same machine. Every warm graph is its cold pair's bytes. Saved with the `-m6.8b` suffix so M6.8's report stays.
- **A shared package edited: 0.92× (was 0.85×).** 88 services collected, 25 reused: 38.5 s against 35.3 s cold (109%, was 120%). Time outside every stage (writing the 88 entries) is 1.8 to 2.4 s per run (was 5.2 to 6.3 s); `programs` is 1.5 s over cold (13.5 vs 12.0 s: keys and reading 112 entries). The rest of the stages are within noise. See the commits report for what's left (the same inputs stored in ~80 entries, M6.8c).
- **Unchanged and leaf-app cases: as before.** Unchanged 8.7 s against 35.1 s (4.0×; M6.8: 4.1×); `apps/api/v2/src/main.ts` edited 17.1 s against 38.7 s (2.3×; M6.8: 2.4×). Both are within this machine's noise of M6.8's numbers; their warm runs do almost no storing, so the change wasn't expected to move them.
- **Memory:** unchanged warm runs peak at 576 MiB (was 417 MiB) and leaf edits at 1,037 MiB (was 845 MiB): all 113 entries are now read at once rather than one at a time. Both stay far below a cold run's 2.3 GiB, which the worker's budget is sized for (ADR-0146).
- **Not measured:** as in M6.8's report (Linux, Cloud Run's 1 vCPU, the worker's 64 MiB in-memory cache).
