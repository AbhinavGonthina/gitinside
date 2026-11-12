# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `007230bd0ad36288276edabceb92f64c298b7256`)
- **Method:** the 10 first-parent commits ending at the pinned SHA are replayed (EVALUATION.md §2: the diff of consecutive real commits, applied one at a time). 1 cold warm-up run at the commit before them (`1251ba5be567d26a7f922452fe7797642376476e`), then one cold run there filling a disk fact cache (`openDiskCache`). Each commit is then checked out in turn and analyzed twice, each run a fresh Node process: with no cache (cold) and with the cache (warm), in alternating order. The cache is never reset, so each warm run reuses what the previous commit's warm run stored. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 32,342 ms, 113 entries written, 25 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| 10 consecutive commits | each commit's diff (below) | 35,387 ms (29,534 ms to 39,661 ms) | 42,611 ms (9,214 ms to 45,220 ms) | 120% | 112 (107 to 113) | 88 (0 to 90) | yes |

## 10 consecutive commits

Median speedup per commit (cold ÷ warm): **0.84×** (0.80× to 3.82×).

| Commit | Cold | Warm | Cold ÷ warm | Services collected |
|---|---:|---:|---:|---:|
| [`b3321936c3`](https://github.com/calcom/cal.com/commit/b3321936c347744a759e0f36a9793bb78c9bca78) | 29,534 ms | 36,885 ms | 0.80× | 88 |
| [`569a389e84`](https://github.com/calcom/cal.com/commit/569a389e84320a8036a2545f3f656f3123bd08f9) | 32,357 ms | 38,634 ms | 0.84× | 88 |
| [`39c96bc04d`](https://github.com/calcom/cal.com/commit/39c96bc04d7513ffd3185fbbf60ba4cb7b32586d) | 33,577 ms | 39,820 ms | 0.84× | 88 |
| [`b0a34f21c9`](https://github.com/calcom/cal.com/commit/b0a34f21c91ae7803f9b7e2c59c2fbd187cce26f) | 36,812 ms | 45,220 ms | 0.81× | 89 |
| [`6bc4529822`](https://github.com/calcom/cal.com/commit/6bc45298226f96ff79e0c070c8b2ce39727e8477) | 37,106 ms | 43,592 ms | 0.85× | 88 |
| [`c339c9c479`](https://github.com/calcom/cal.com/commit/c339c9c47998d5213aab7701c99aa246db4619d3) | 36,150 ms | 42,699 ms | 0.85× | 89 |
| [`54343aa685`](https://github.com/calcom/cal.com/commit/54343aa685ae8f33159d2f485ec4a57bad5c574a) | 39,661 ms | 43,324 ms | 0.92× | 88 |
| [`1dbaf8e7b4`](https://github.com/calcom/cal.com/commit/1dbaf8e7b42434cc1dfae9966dfd345dffd325ef) | 35,184 ms | 42,976 ms | 0.82× | 90 |
| [`6bfe2df9d1`](https://github.com/calcom/cal.com/commit/6bfe2df9d13c456dc9374c9e6581b36fba188728) | 35,590 ms | 42,523 ms | 0.84× | 88 |
| [`0f19cc46ef`](https://github.com/calcom/cal.com/commit/0f19cc46ef6b6426ee398c670575b3c96be7af9e) | 35,158 ms | 9,214 ms | 3.82× | 0 |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| 10 consecutive commits | 2319 MiB (2163 MiB to 2325 MiB) | 2265 MiB (410 MiB to 2352 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | 10 consecutive commits: cold | 10 consecutive commits: warm |
|---|---:|---:|
| inventory | 3,430 ms | 3,212 ms |
| workspace | 29 ms | 26 ms |
| programs | 12,364 ms | 13,953 ms |
| imports | 2,019 ms | 2,048 ms |
| express | 43 ms | 40 ms |
| next | 701 ms | 661 ms |
| prisma | 1,181 ms | 1,193 ms |
| infra | 33 ms | 34 ms |
| files | 2,672 ms | 2,701 ms |
| symbols | 55 ms | 52 ms |
| calls | 4,890 ms | 5,019 ms |
| http | 4,091 ms | 4,076 ms |
| sdk | 1,367 ms | 1,361 ms |
| queues | 2,072 ms | 2,006 ms |
| assemble | 328 ms | 307 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **On real commits the cache doesn't pay off yet: median 0.84×, so warm runs are slower.** EVALUATION.md §2's measure (10 consecutive real commits, median speedup) comes out at 0.84× for cal.com. Nine of the ten commits change TypeScript source, and each of them re-collected 88 to 90 of the 113 services; those warm runs took 0.80× to 0.92× of cold. Only the pinned commit `0f19cc4`, which changes nothing but `packages/i18n/locales/tr/common.json`, reused every service: 9.2 s against 35.2 s (3.82×).
- **Why so many services are collected.** The changed files vary widely: one Tooltip component in `packages/ui`, one file in `packages/embeds/embed-core`, one in `packages/features`, two files in `apps/web` (`39c96bc`, `54343aa`), a 32-file feature across `apps/web` and four packages (`1dbaf8e`). Yet each re-collected the same 88 services, give or take two. So the files these commits touch are among the inputs of the same 88 entries: those services' TypeScript programs reach one large shared set of files. One reason that set includes `apps/web`: `packages/lib/hooks/useLocale.ts` imports `@calcom/web/app/AppRouterI18nProvider` and `@calcom/web/app/CustomI18nProvider`, and most services import `packages/lib`. The synthetic edit report shows the same split: a `packages/lib` edit re-collected 88 services (0.85×), and a leaf app edit 1 (2.4×). A service's entry is invalidated by any file its program read, so in a repo whose packages import one another this widely, per-service reuse rarely applies.
- **Where the extra time goes.** The stages of a mostly re-collected warm run sum to about a cold run's (`programs` 14.0 s vs 12.4 s; it also reads and checks 112 entries; the other stages are within noise). On top of that, 4.6 to 6.2 s per warm run goes outside every stage: hashing the collected services' inputs and writing their 88 to 90 entries (cold runs: 2 to 6 ms; the fully reused run: 16 ms). The fill run spent 4.6 s there.
- **What this means.** The cache works as designed (every warm graph is its cold pair's bytes, and a change outside every program's reach is reused in full) but, at service granularity, it helps cal.com only for edits in leaf apps or outside the TypeScript programs. Follow-up M6.8b: cut the storing and checking cost so a mostly re-collected warm run is no slower than cold, then measure again. Whether finer reuse (per file within a service, SPEC D3.4's wording) is worth it goes to the M6 review.
- **Memory:** a re-collected warm run peaks at about cold's 2.3 GiB; the fully reused run at 410 MiB.
- **Not measured:** Linux, Cloud Run, a second monorepo with fewer cross-package imports, and PR-sized base/head pairs (M7's backtest replays those).
