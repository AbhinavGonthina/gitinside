# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `7808c38f79d1b82383f9c69ae96f833a784bcf3f`)
- **Method:** the 10 first-parent commits ending at the pinned SHA are replayed (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time). 1 cold warm-up run at the commit before them (`1251ba5be567d26a7f922452fe7797642376476e`), then one cold run there filling a disk fact cache (`openDiskCache`). Each commit is then checked out in turn and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 30,349 ms, 113 entries written, 25 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| 10 consecutive commits | each commit's diff (below) | 35,550 ms (29,192 ms to 40,087 ms) | 38,191 ms (9,214 ms to 43,939 ms) | 107% | 112 (107 to 113) | 88 (0 to 90) | yes |

## 10 consecutive commits

Median speedup per commit (cold ÷ warm): **0.91×** (0.85× to 3.72×).

| Commit | Cold | Warm | Cold ÷ warm | Services collected |
|---|---:|---:|---:|---:|
| [`b3321936c3`](https://github.com/calcom/cal.com/commit/b3321936c347744a759e0f36a9793bb78c9bca78) | 29,192 ms | 34,494 ms | 0.85× | 88 |
| [`569a389e84`](https://github.com/calcom/cal.com/commit/569a389e84320a8036a2545f3f656f3123bd08f9) | 32,814 ms | 36,194 ms | 0.91× | 88 |
| [`39c96bc04d`](https://github.com/calcom/cal.com/commit/39c96bc04d7513ffd3185fbbf60ba4cb7b32586d) | 34,078 ms | 36,741 ms | 0.93× | 88 |
| [`b0a34f21c9`](https://github.com/calcom/cal.com/commit/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f) | 35,512 ms | 37,569 ms | 0.95× | 89 |
| [`6bc4529822`](https://github.com/calcom/cal.com/commit/6bc45298226f96ff79e0c070c8b2ce39727e8477) | 39,448 ms | 42,612 ms | 0.93× | 88 |
| [`c339c9c479`](https://github.com/calcom/cal.com/commit/c339c9c47998d5213aab7701c99aa246db4619d3) | 40,087 ms | 43,939 ms | 0.91× | 89 |
| [`54343aa685`](https://github.com/calcom/cal.com/commit/54343aa685ae8f33159d2f485ec4a57bad5c574a) | 38,331 ms | 43,281 ms | 0.89× | 88 |
| [`1dbaf8e7b4`](https://github.com/calcom/cal.com/commit/1dbaf8e7b42434cc1dfae9966dfd345dffd325ef) | 36,873 ms | 41,579 ms | 0.89× | 90 |
| [`6bfe2df9d1`](https://github.com/calcom/cal.com/commit/6bfe2df9d13c456dc9374c9e6581b36fba188728) | 35,588 ms | 38,812 ms | 0.92× | 88 |
| [`0f19cc46ef`](https://github.com/calcom/cal.com/commit/0f19cc46ef6b6426ee398c670575b3c96be7af9e) | 34,303 ms | 9,214 ms | 3.72× | 0 |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| 10 consecutive commits | 2316 MiB (2024 MiB to 2326 MiB) | 2287 MiB (587 MiB to 2452 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | 10 consecutive commits: cold | 10 consecutive commits: warm |
|---|---:|---:|
| inventory | 3,345 ms | 3,351 ms |
| workspace | 29 ms | 30 ms |
| programs | 12,034 ms | 13,479 ms |
| imports | 2,069 ms | 1,980 ms |
| express | 42 ms | 41 ms |
| next | 698 ms | 655 ms |
| prisma | 1,186 ms | 1,184 ms |
| infra | 31 ms | 34 ms |
| files | 2,743 ms | 2,946 ms |
| symbols | 55 ms | 51 ms |
| calls | 4,888 ms | 4,969 ms |
| http | 4,225 ms | 4,048 ms |
| sdk | 1,372 ms | 1,347 ms |
| queues | 2,111 ms | 2,030 ms |
| assemble | 319 ms | 353 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **What changed since M6.8's report** (`2026-11-02-incremental-calcom-commits.md`, gitinside `482b65d`): only how cache entries are stored and checked (gitinside `10dd9db`, ADR-0179; the commits after it before `7808c38` are reports only). Each program's inputs are snapshotted once, services that reached the same programs share one merged inputs object and one digest (verified once per run), and the disk cache compresses on the thread pool, 4 entries at a time. Same commits, same fill commit, same machine; every warm graph is again its cold pair's bytes. The report's own name would have replaced M6.8's, so it was saved with the `-m6.8b` suffix.
- **Median 0.91× (was 0.84×): better, still slower than cold.** The nine commits that change TypeScript source again re-collected 88 to 90 of 113 services; their warm runs now take 0.85× to 0.95× of cold (were 0.80× to 0.92×). The locale-only commit `0f19cc4` reused everything: 9.2 s against 34.3 s (3.72×).
- **Where the time went.** Time outside every stage (computing and writing the collected services' entries) is now 1.8 to 2.4 s per re-collected warm run, down from 4.6 to 6.2 s; the fill run's 1.7 s, from 4.6 s. `programs` is still about 1.5 s over its cold pair (0.4 to 2.5 s): computing the keys (hashing every service's own files, ~0.6 s) and reading 112 entries. The other stages are within noise.
- **What's left is duplication.** About 80 of the entries carry the same 1.3 MB of recorded inputs (119 of the cache's 138 MB before compression): each is still serialized, compressed, written, read back, and parsed once per entry, even though it's verified once. Storing each distinct inputs set once and pointing entries at it is follow-up M6.8c; it changes how many cache entries a service takes, so the worker's counters, the container check, and this report's columns change with it.
- **Memory:** a re-collected warm run peaks at 2.3 GiB like cold; the fully reused run at 587 MiB (was 410 MiB), because all 113 entries are now read at once.
- **Not measured:** as in M6.8's report (Linux, Cloud Run, a second monorepo, PR-sized base/head pairs).
