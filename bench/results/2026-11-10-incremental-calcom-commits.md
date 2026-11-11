# Incremental analysis benchmark: calcom (2026-11-10)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.3.0 (gitinside `6df17b7c8bd507f104c4bd7b1f5bd1e2f10f330d`)
- **Method:** the 10 first-parent commits ending at the pinned SHA are replayed (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time). 1 cold warm-up run at the commit before them (`1251ba5be567d26a7f922452fe7797642376476e`), then one cold run there filling a disk fact cache (`openDiskCache`). Each commit is then checked out in turn and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 109,510 ms, 114 entries written, 2 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| 10 consecutive commits | each commit's diff (below) | 101,934 ms (33,584 ms to 104,550 ms) | 100,975 ms (8,515 ms to 109,838 ms) | 99% | 113 (108 to 114) | 89 (0 to 91) | yes |

## 10 consecutive commits

Median speedup per commit (cold ÷ warm): **1.02×** (0.31× to 11.90×).

| Commit | Cold | Warm | Cold ÷ warm | Services collected |
|---|---:|---:|---:|---:|
| [`b3321936c3`](https://github.com/calcom/cal.com/commit/b3321936c347744a759e0f36a9793bb78c9bca78) | 101,990 ms | 99,986 ms | 1.02× | 89 |
| [`569a389e84`](https://github.com/calcom/cal.com/commit/569a389e84320a8036a2545f3f656f3123bd08f9) | 101,890 ms | 99,867 ms | 1.02× | 89 |
| [`39c96bc04d`](https://github.com/calcom/cal.com/commit/39c96bc04d7513ffd3185fbbf60ba4cb7b32586d) | 103,563 ms | 101,063 ms | 1.02× | 89 |
| [`b0a34f21c9`](https://github.com/calcom/cal.com/commit/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f) | 101,706 ms | 102,459 ms | 0.99× | 90 |
| [`6bc4529822`](https://github.com/calcom/cal.com/commit/6bc45298226f96ff79e0c070c8b2ce39727e8477) | 101,977 ms | 101,875 ms | 1.00× | 89 |
| [`c339c9c479`](https://github.com/calcom/cal.com/commit/c339c9c47998d5213aab7701c99aa246db4619d3) | 102,009 ms | 100,887 ms | 1.01× | 90 |
| [`54343aa685`](https://github.com/calcom/cal.com/commit/54343aa685ae8f33159d2f485ec4a57bad5c574a) | 104,550 ms | 101,841 ms | 1.03× | 89 |
| [`1dbaf8e7b4`](https://github.com/calcom/cal.com/commit/1dbaf8e7b42434cc1dfae9966dfd345dffd325ef) | 87,737 ms | 100,046 ms | 0.88× | 91 |
| [`6bfe2df9d1`](https://github.com/calcom/cal.com/commit/6bfe2df9d13c456dc9374c9e6581b36fba188728) | 33,584 ms | 109,838 ms | 0.31× | 89 |
| [`0f19cc46ef`](https://github.com/calcom/cal.com/commit/0f19cc46ef6b6426ee398c670575b3c96be7af9e) | 101,313 ms | 8,515 ms | 11.90× | 0 |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| 10 consecutive commits | 2126 MiB (1869 MiB to 2186 MiB) | 2099 MiB (204 MiB to 2159 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | 10 consecutive commits: cold | 10 consecutive commits: warm |
|---|---:|---:|
| inventory | 3,356 ms | 3,145 ms |
| workspace | 80 ms | 103 ms |
| programs | 22,076 ms | 20,610 ms |
| imports | 11,011 ms | 10,632 ms |
| express | 164 ms | 156 ms |
| next | 98 ms | 108 ms |
| prisma | 2,365 ms | 2,373 ms |
| infra | 72 ms | 74 ms |
| files | 144 ms | 139 ms |
| symbols | 195 ms | 198 ms |
| calls | 22,342 ms | 22,560 ms |
| http | 25,853 ms | 25,547 ms |
| sdk | 4,676 ms | 4,799 ms |
| queues | 7,838 ms | 7,388 ms |
| assemble | 972 ms | 900 ms |

Raw per-run numbers are in the JSON file next to this report.
