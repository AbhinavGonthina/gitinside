# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `95334da94cc8058796a1b3ae9c60f81bad2e27be`)
- **Method:** 1 cold warm-up run, then one cold run filling a disk fact cache (`openDiskCache`) from the unedited tree. Each case then makes 5 pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 22,793 ms, 113 entries written, 2 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| Nothing changed | none | 24,918 ms (21,824 ms to 26,110 ms) | 4,356 ms (3,649 ms to 4,918 ms) | 17% | 113 | 0 | yes |
| One leaf app edited | `apps/api/v2/src/main.ts` | 35,627 ms (26,908 ms to 43,649 ms) | 12,550 ms (9,643 ms to 12,902 ms) | 35% | 112 | 1 | yes |
| A shared package edited | `packages/lib/constants.ts` | 35,728 ms (34,796 ms to 36,683 ms) | 36,313 ms (34,976 ms to 37,197 ms) | 102% | 112 | 88 | yes |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| Nothing changed | 2292 MiB (2046 MiB to 2305 MiB) | 190 MiB (188 MiB to 191 MiB) |
| One leaf app edited | 2163 MiB (2067 MiB to 2325 MiB) | 639 MiB (631 MiB to 651 MiB) |
| A shared package edited | 2204 MiB (2036 MiB to 2318 MiB) | 2131 MiB (1937 MiB to 2212 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | Nothing changed: cold | Nothing changed: warm | One leaf app edited: cold | One leaf app edited: warm | A shared package edited: cold | A shared package edited: warm |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 2,780 ms | 2,769 ms | 4,656 ms | 4,438 ms | 4,757 ms | 4,669 ms |
| workspace | 26 ms | 26 ms | 39 ms | 36 ms | 46 ms | 48 ms |
| programs | 7,195 ms | 1,105 ms | 9,228 ms | 2,408 ms | 9,280 ms | 9,224 ms |
| imports | 1,813 ms | 24 ms | 2,359 ms | 267 ms | 2,374 ms | 2,493 ms |
| express | 39 ms | 2 ms | 52 ms | 9 ms | 64 ms | 57 ms |
| next | 620 ms | 0 ms | 836 ms | 1 ms | 822 ms | 770 ms |
| prisma | 1,050 ms | 18 ms | 1,420 ms | 403 ms | 1,400 ms | 1,422 ms |
| infra | 28 ms | 33 ms | 37 ms | 35 ms | 40 ms | 37 ms |
| files | 53 ms | 53 ms | 74 ms | 62 ms | 74 ms | 69 ms |
| symbols | 54 ms | 0 ms | 105 ms | 12 ms | 89 ms | 70 ms |
| calls | 4,172 ms | 14 ms | 5,531 ms | 2,475 ms | 6,180 ms | 5,717 ms |
| http | 3,598 ms | 16 ms | 5,224 ms | 730 ms | 5,132 ms | 5,261 ms |
| sdk | 1,237 ms | 1 ms | 1,822 ms | 220 ms | 1,838 ms | 1,754 ms |
| queues | 1,888 ms | 0 ms | 2,903 ms | 416 ms | 2,826 ms | 2,747 ms |
| assemble | 292 ms | 258 ms | 428 ms | 328 ms | 431 ms | 393 ms |

Raw per-run numbers are in the JSON file next to this report.
