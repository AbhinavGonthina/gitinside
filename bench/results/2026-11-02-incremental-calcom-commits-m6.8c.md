# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `9892d4cc68792eb031c985d1e3f2172b3325bbea`)
- **Method:** the 10 first-parent commits ending at the pinned SHA are replayed (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time). 1 cold warm-up run at the commit before them (`1251ba5be567d26a7f922452fe7797642376476e`), then one cold run there filling a disk fact cache (`openDiskCache`). Each commit is then checked out in turn and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 29,131 ms, 113 entries written, 7 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| 10 consecutive commits | each commit's diff (below) | 34,884 ms (27,883 ms to 38,000 ms) | 36,212 ms (9,484 ms to 44,287 ms) | 104% | 112 (107 to 113) | 88 (0 to 90) | yes |

## 10 consecutive commits

Median speedup per commit (cold ÷ warm): **0.94×** (0.84× to 4.01×).

| Commit | Cold | Warm | Cold ÷ warm | Services collected |
|---|---:|---:|---:|---:|
| [`b3321936c3`](https://github.com/calcom/cal.com/commit/b3321936c347744a759e0f36a9793bb78c9bca78) | 27,883 ms | 32,467 ms | 0.86× | 88 |
| [`569a389e84`](https://github.com/calcom/cal.com/commit/569a389e84320a8036a2545f3f656f3123bd08f9) | 32,347 ms | 33,132 ms | 0.98× | 88 |
| [`39c96bc04d`](https://github.com/calcom/cal.com/commit/39c96bc04d7513ffd3185fbbf60ba4cb7b32586d) | 33,031 ms | 35,537 ms | 0.93× | 88 |
| [`b0a34f21c9`](https://github.com/calcom/cal.com/commit/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f) | 34,849 ms | 36,231 ms | 0.96× | 89 |
| [`6bc4529822`](https://github.com/calcom/cal.com/commit/6bc45298226f96ff79e0c070c8b2ce39727e8477) | 34,611 ms | 36,192 ms | 0.96× | 88 |
| [`c339c9c479`](https://github.com/calcom/cal.com/commit/c339c9c47998d5213aab7701c99aa246db4619d3) | 36,236 ms | 37,826 ms | 0.96× | 89 |
| [`54343aa685`](https://github.com/calcom/cal.com/commit/54343aa685ae8f33159d2f485ec4a57bad5c574a) | 34,920 ms | 37,935 ms | 0.92× | 88 |
| [`1dbaf8e7b4`](https://github.com/calcom/cal.com/commit/1dbaf8e7b42434cc1dfae9966dfd345dffd325ef) | 35,250 ms | 38,436 ms | 0.92× | 90 |
| [`6bfe2df9d1`](https://github.com/calcom/cal.com/commit/6bfe2df9d13c456dc9374c9e6581b36fba188728) | 37,065 ms | 44,287 ms | 0.84× | 88 |
| [`0f19cc46ef`](https://github.com/calcom/cal.com/commit/0f19cc46ef6b6426ee398c670575b3c96be7af9e) | 38,000 ms | 9,484 ms | 4.01× | 0 |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| 10 consecutive commits | 2220 MiB (1995 MiB to 2322 MiB) | 2111 MiB (284 MiB to 2247 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | 10 consecutive commits: cold | 10 consecutive commits: warm |
|---|---:|---:|
| inventory | 3,214 ms | 3,333 ms |
| workspace | 29 ms | 29 ms |
| programs | 11,965 ms | 12,510 ms |
| imports | 1,984 ms | 2,060 ms |
| express | 42 ms | 42 ms |
| next | 706 ms | 653 ms |
| prisma | 1,155 ms | 1,192 ms |
| infra | 34 ms | 35 ms |
| files | 2,651 ms | 2,629 ms |
| symbols | 52 ms | 51 ms |
| calls | 4,820 ms | 4,916 ms |
| http | 4,116 ms | 3,927 ms |
| sdk | 1,357 ms | 1,285 ms |
| queues | 2,088 ms | 1,942 ms |
| assemble | 324 ms | 343 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **What changed since M6.8b's report** (`2026-11-02-incremental-calcom-commits-m6.8b.md`): each distinct set of observed inputs is stored once (gitinside `eb1995d`, ADR-0180); the run was at `9892d4c`, which adds only the edits benchmark's report. Same commits, same machine; every warm graph is its cold pair's bytes. Saved with the `-m6.8c` suffix.
- **Median 0.94× (M6.8b: 0.91×, M6.8: 0.84×), still not parity.** Eight of the nine source-changing commits are 0.86–0.98×; `6bfe2df9d1` is 0.84× (44.3 s warm, with 15.5 s in `programs`, the slowest of any run here, likely noise on this laptop). The locale-JSON commit `0f19cc46ef` reuses everything: 4.01×.
- **Where the rest goes:** per re-collected warm run, 0.9–1.6 s outside every stage (storing 88–90 service entries and their few new inputs sets; M6.8b's report measured 1.8–2.4 s on the edits) and 0.4–2.2 s more in `programs` than its cold pair (median ≈ 0.9 s: keys and reading the entries found). The detector stages are within noise of cold. M6.8c2 profiles those two parts.
- **Memory:** the fully reused commit peaks at 284 MiB (M6.8b: 587 MiB).
- **Not measured:** as in M6.8's report.
