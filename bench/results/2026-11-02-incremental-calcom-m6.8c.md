# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `5c5af2103d50cf63c810d190ffeea1d49cefd801`)
- **Method:** 1 cold warm-up run, then one cold run filling a disk fact cache (`openDiskCache`) from the unedited tree. Each case then makes 5 pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 29,659 ms, 113 entries written, 7 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| Nothing changed | none | 32,663 ms (29,085 ms to 37,221 ms) | 8,255 ms (7,002 ms to 8,776 ms) | 25% | 113 | 0 | yes |
| One leaf app edited | `apps/api/v2/src/main.ts` | 37,886 ms (35,459 ms to 39,144 ms) | 15,437 ms (14,839 ms to 15,720 ms) | 41% | 112 | 1 | yes |
| A shared package edited | `packages/lib/constants.ts` | 34,668 ms (34,272 ms to 35,612 ms) | 37,562 ms (36,580 ms to 38,570 ms) | 108% | 112 | 88 | yes |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| Nothing changed | 2163 MiB (2061 MiB to 2308 MiB) | 285 MiB (281 MiB to 308 MiB) |
| One leaf app edited | 2309 MiB (2039 MiB to 2310 MiB) | 618 MiB (613 MiB to 621 MiB) |
| A shared package edited | 2306 MiB (2062 MiB to 2312 MiB) | 2108 MiB (1992 MiB to 2237 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | Nothing changed: cold | Nothing changed: warm | One leaf app edited: cold | One leaf app edited: warm | A shared package edited: cold | A shared package edited: warm |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 3,121 ms | 3,287 ms | 3,586 ms | 3,497 ms | 3,259 ms | 3,423 ms |
| workspace | 29 ms | 29 ms | 32 ms | 32 ms | 29 ms | 27 ms |
| programs | 10,378 ms | 1,525 ms | 12,759 ms | 3,236 ms | 11,890 ms | 13,021 ms |
| imports | 2,044 ms | 27 ms | 2,169 ms | 221 ms | 2,002 ms | 2,020 ms |
| express | 41 ms | 2 ms | 47 ms | 11 ms | 40 ms | 39 ms |
| next | 634 ms | 0 ms | 757 ms | 1 ms | 696 ms | 661 ms |
| prisma | 1,156 ms | 18 ms | 1,262 ms | 410 ms | 1,163 ms | 1,221 ms |
| infra | 33 ms | 30 ms | 34 ms | 41 ms | 34 ms | 34 ms |
| files | 2,942 ms | 2,916 ms | 3,083 ms | 3,155 ms | 2,755 ms | 2,861 ms |
| symbols | 52 ms | 0 ms | 61 ms | 11 ms | 54 ms | 50 ms |
| calls | 4,737 ms | 15 ms | 5,357 ms | 3,083 ms | 4,824 ms | 5,026 ms |
| http | 4,088 ms | 11 ms | 4,336 ms | 669 ms | 4,018 ms | 4,045 ms |
| sdk | 1,360 ms | 1 ms | 1,432 ms | 213 ms | 1,394 ms | 1,333 ms |
| queues | 2,073 ms | 0 ms | 2,247 ms | 366 ms | 2,075 ms | 1,995 ms |
| assemble | 322 ms | 274 ms | 344 ms | 313 ms | 316 ms | 333 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **What changed since M6.8b's report** (`2026-11-02-incremental-calcom-m6.8b.md`, gitinside `0bdfe63`): each distinct set of observed inputs is now one cache entry that service entries name by digest (gitinside `eb1995d`, ADR-0180; `5c5af21` after it only re-records the eval report). Same cases, same machine. Every warm graph is its cold pair's bytes. Saved with the `-m6.8c` suffix so the earlier reports stay.
- **The cache on disk: 7 MiB, was 25 MiB**, for the same 113 service entries (plus their distinct inputs entries, which the "entries written" count leaves out: it counts per service).
- **A shared package edited: still 0.92× (108%, was 109%).** 88 services collected: 37.6 s against 34.7 s cold. Time outside every stage (storing) is 1.0–1.1 s per run (M6.8b: 1.8–2.4 s), but `programs` is still 1.1 s over cold (13.0 vs 11.9 s median: keys hash every service's own files, and the 112 entries found are read and checked), and the rest of the gap is in the re-collected stages, within noise of cold. M6.8c2 looks at those two.
- **Unchanged and leaf-app cases:** unchanged 8.3 s against 32.7 s (4.0×); `apps/api/v2/src/main.ts` edited 15.4 s against 37.9 s (2.5×, M6.8b: 2.3×), within this machine's noise.
- **Memory:** unchanged warm runs peak at 285 MiB (M6.8b: 576 MiB) and leaf edits at 618 MiB (1,037 MiB): reading every entry at once now reads one copy of the shared inputs, not ~80.
- **Not measured:** as in M6.8's report (Linux, Cloud Run's 1 vCPU, the worker's 64 MiB in-memory cache).
