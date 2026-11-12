# Incremental analysis benchmark: calcom (2026-11-10)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.3.0 (gitinside `14c27784856e47ab9898d3607910975dda68455f`)
- **Method:** 1 cold warm-up run, then one cold run filling a disk fact cache (`openDiskCache`) from the unedited tree. Each case then makes 5 pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 108,727 ms, 114 entries written, 2 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| Nothing changed | none | 108,327 ms (108,077 ms to 113,089 ms) | 6,607 ms (5,978 ms to 7,191 ms) | 6% | 114 | 0 | yes |
| One leaf app edited | `apps/api/v2/src/main.ts` | 109,035 ms (107,172 ms to 112,970 ms) | 25,476 ms (25,129 ms to 25,682 ms) | 23% | 113 | 1 | yes |
| A shared package edited | `packages/lib/constants.ts` | 103,623 ms (102,339 ms to 108,680 ms) | 102,314 ms (100,093 ms to 104,222 ms) | 99% | 113 | 89 | yes |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| Nothing changed | 1922 MiB (1885 MiB to 2160 MiB) | 206 MiB (203 MiB to 229 MiB) |
| One leaf app edited | 1932 MiB (1842 MiB to 2135 MiB) | 646 MiB (641 MiB to 647 MiB) |
| A shared package edited | 1930 MiB (1856 MiB to 2187 MiB) | 2085 MiB (1774 MiB to 2104 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | Nothing changed: cold | Nothing changed: warm | One leaf app edited: cold | One leaf app edited: warm | A shared package edited: cold | A shared package edited: warm |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 2,465 ms | 2,530 ms | 2,501 ms | 2,482 ms | 3,036 ms | 2,683 ms |
| workspace | 26 ms | 42 ms | 25 ms | 25 ms | 96 ms | 33 ms |
| programs | 23,578 ms | 2,244 ms | 23,200 ms | 5,455 ms | 21,842 ms | 20,585 ms |
| imports | 11,886 ms | 108 ms | 12,342 ms | 1,864 ms | 11,978 ms | 10,693 ms |
| express | 184 ms | 5 ms | 166 ms | 29 ms | 165 ms | 160 ms |
| next | 121 ms | 1 ms | 110 ms | 2 ms | 99 ms | 112 ms |
| prisma | 2,712 ms | 75 ms | 2,595 ms | 511 ms | 2,377 ms | 2,345 ms |
| infra | 74 ms | 96 ms | 86 ms | 89 ms | 91 ms | 69 ms |
| files | 130 ms | 169 ms | 168 ms | 128 ms | 169 ms | 142 ms |
| symbols | 249 ms | 1 ms | 233 ms | 53 ms | 212 ms | 196 ms |
| calls | 24,333 ms | 102 ms | 24,118 ms | 9,133 ms | 22,815 ms | 22,867 ms |
| http | 27,582 ms | 211 ms | 28,523 ms | 2,231 ms | 26,701 ms | 25,461 ms |
| sdk | 5,171 ms | 2 ms | 5,238 ms | 769 ms | 5,123 ms | 4,709 ms |
| queues | 8,201 ms | 1 ms | 8,483 ms | 1,331 ms | 8,298 ms | 7,513 ms |
| assemble | 1,011 ms | 907 ms | 1,017 ms | 924 ms | 2,440 ms | 891 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **The launch analyzer (0.3.0, M9.2d), run at `14c2778`.** Every warm graph is its cold pair's bytes. cal.com now has 114 services (M6.8c2: 113), so it fills 114 entries, still 2 MiB on disk.
- **Per pair, cold ÷ warm** (from the JSON, `bench/dist/m92d-pairs.mjs`; compare within a pair):
  - Nothing changed: 15.0–18.1×, median 16.8× (M6.8c2: 5.3–6.6×).
  - One leaf app edited: 4.21–4.47×, median 4.28× (M6.8c2: 2.73–4.36×, median 2.79×).
  - A shared package edited: 0.99–1.06×, median 1.03× (M6.8c2: 0.94–1.03×, median 0.99×). 89 services are collected again (an input they recorded changed), so this case costs about a cold run, as before.
- **The ratios rose because cold rose more than warm.** Warm took 6.6 s with nothing changed (M6.8c2: 4.4 s) and 25.5 s with a leaf app edited (12.6 s). Cold took 102.3–113.1 s (21.8–43.6 s). The laptop ran about 3× slower than it can for most of this session (the commit replay's 33.6 s cold run, `2026-11-10-incremental-calcom-commits.md`). The slowdown is uneven, though. The stage that mostly reads files didn't slow (inventory, with nothing changed: 2.8 s cold at M6.8c2, 2.5 s now), but the compiler stages did (`programs` 7.2 → 23.6 s cold). A warm run that reuses everything mostly reads, so it slows least. These ratios are this session's, not a speedup to quote against M6.8.
- **One leaf app edited:** the warm run re-collects one service (`apps/api/v2`, 113 entries found). Its `calls` take 9.1 s of the 25.5 s and `programs` 5.5 s.
- **A shared package edited:** warm spends 1.9–2.1 s per run outside every stage, mostly storing 89 service entries (M6.8c2: 0.72–0.85 s).
- **Memory:** with nothing changed, the warm run peaks at 206 MiB (M6.8c2: 190 MiB). With a leaf app edited it peaks at 646 MiB (639 MiB). Cold runs peak at 1,842–2,187 MiB.
