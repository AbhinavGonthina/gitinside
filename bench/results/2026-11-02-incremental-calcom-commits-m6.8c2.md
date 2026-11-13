# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `97f35d38e67364388ffbdf1221a51710ce01e963`)
- **Method:** the 10 first-parent commits ending at the pinned SHA are replayed (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time). 1 cold warm-up run at the commit before them (`1251ba5be567d26a7f922452fe7797642376476e`), then one cold run there filling a disk fact cache (`openDiskCache`). Each commit is then checked out in turn and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 36,561 ms, 113 entries written, 2 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| 10 consecutive commits | each commit's diff (below) | 35,336 ms (34,641 ms to 36,332 ms) | 36,065 ms (6,646 ms to 36,370 ms) | 102% | 112 (107 to 113) | 88 (0 to 90) | yes |

## 10 consecutive commits

Median speedup per commit (cold ÷ warm): **0.99×** (0.96× to 5.27×).

| Commit | Cold | Warm | Cold ÷ warm | Services collected |
|---|---:|---:|---:|---:|
| [`b3321936c3`](https://github.com/calcom/cal.com/commit/b3321936c347744a759e0f36a9793bb78c9bca78) | 35,577 ms | 36,281 ms | 0.98× | 88 |
| [`569a389e84`](https://github.com/calcom/cal.com/commit/569a389e84320a8036a2545f3f656f3123bd08f9) | 34,641 ms | 36,249 ms | 0.96× | 88 |
| [`39c96bc04d`](https://github.com/calcom/cal.com/commit/39c96bc04d7513ffd3185fbbf60ba4cb7b32586d) | 35,222 ms | 35,960 ms | 0.98× | 88 |
| [`b0a34f21c9`](https://github.com/calcom/cal.com/commit/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f) | 36,143 ms | 35,760 ms | 1.01× | 89 |
| [`6bc4529822`](https://github.com/calcom/cal.com/commit/6bc45298226f96ff79e0c070c8b2ce39727e8477) | 35,685 ms | 36,170 ms | 0.99× | 88 |
| [`c339c9c479`](https://github.com/calcom/cal.com/commit/c339c9c47998d5213aab7701c99aa246db4619d3) | 35,154 ms | 35,723 ms | 0.98× | 89 |
| [`54343aa685`](https://github.com/calcom/cal.com/commit/54343aa685ae8f33159d2f485ec4a57bad5c574a) | 35,072 ms | 34,913 ms | 1.00× | 88 |
| [`1dbaf8e7b4`](https://github.com/calcom/cal.com/commit/1dbaf8e7b42434cc1dfae9966dfd345dffd325ef) | 36,332 ms | 36,370 ms | 1.00× | 90 |
| [`6bfe2df9d1`](https://github.com/calcom/cal.com/commit/6bfe2df9d13c456dc9374c9e6581b36fba188728) | 35,449 ms | 36,172 ms | 0.98× | 88 |
| [`0f19cc46ef`](https://github.com/calcom/cal.com/commit/0f19cc46ef6b6426ee398c670575b3c96be7af9e) | 35,054 ms | 6,646 ms | 5.27× | 0 |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| 10 consecutive commits | 2132 MiB (2037 MiB to 2328 MiB) | 2103 MiB (190 MiB to 2258 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | 10 consecutive commits: cold | 10 consecutive commits: warm |
|---|---:|---:|
| inventory | 4,745 ms | 4,737 ms |
| workspace | 44 ms | 45 ms |
| programs | 9,174 ms | 9,429 ms |
| imports | 2,429 ms | 2,396 ms |
| express | 61 ms | 53 ms |
| next | 832 ms | 776 ms |
| prisma | 1,408 ms | 1,431 ms |
| infra | 40 ms | 37 ms |
| files | 74 ms | 72 ms |
| symbols | 84 ms | 76 ms |
| calls | 6,033 ms | 5,956 ms |
| http | 5,232 ms | 5,159 ms |
| sdk | 1,807 ms | 1,777 ms |
| queues | 2,801 ms | 2,720 ms |
| assemble | 427 ms | 407 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **What changed since M6.8c1's report** (`2026-11-02-incremental-calcom-commits-m6.8c.md`): every run reads each repo file once, side by side, and shares it between the cache keys, the compiler hosts, and the file nodes (gitinside `1b91524`); observed inputs are stored in parts by owning service, each distinct part once (`81df32b`, ADR-0181). The run was at `97f35d3`, which adds only the edits benchmark's report. Same commits; every warm graph is its cold pair's bytes. Saved with the `-m6.8c2` suffix.
- **Median 0.99× (M6.8c1: 0.94×, M6.8b: 0.91×, M6.8: 0.84×).** The nine source-changing commits are 0.96–1.01×; warm is 0.04–1.6 s behind cold on seven of them and ahead on two (`b0a34f21c9`, `54343aa685`). The locale-JSON commit `0f19cc46ef` reuses everything: 5.27× (M6.8c1: 4.01×).
- **The laptop ran slower during this benchmark than while profiling:** cold took 34.6–36.3 s here (M6.8c1's report: 27.9–38.0 s), though the shared reader cut one cold run of `6bfe2df` from 29.0 to 22.1 s when measured back to back (the edits report's first cold runs were 21.8–26.1 s, then rose to ~35 s). The code was the same for every run here, so compare cold and warm within a pair, not across reports.
- **Where the rest goes:** 0.72–0.85 s per re-collected warm run outside every stage (storing 88–90 service entries and 1–8 new inputs parts; M6.8c1: 0.9–1.6 s storing 88 entries plus whole inputs sets), and `programs` −0.3 to +0.8 s against its cold pair (keys, reading 112 entries and ~198 parts). The detector stages are within noise of cold.
- **Cache size:** 1.9 MiB after filling (M6.8c1: 7 MiB), 4.1 MiB after the ten commits.
- **Memory:** the fully reused commit peaks at 190 MiB (M6.8c1: 284 MiB).
- **Not measured:** as in M6.8's report.
