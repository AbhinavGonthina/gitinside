# Incremental analysis benchmark: calcom (2026-11-02)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `681a8933cb74e779e94f22227027bdb93c151a69`)
- **Method:** 1 cold warm-up run, then one cold run filling a disk fact cache (`openDiskCache`) from the unedited tree. Each case then makes 5 pairs of runs on the same tree, each run a fresh Node process: one with no cache (cold) and one with the cache (warm), in alternating order. An edit case appends a line declaring a new exported constant, different in each pair, to one file before the pair and restores the file after it, so no warm run finds its own edit in the cache. Opening the cache is part of the warm time.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Filling the cache:** 36,896 ms, 113 entries written, 25 MiB on disk.
- **Warm graphs identical to cold:** yes, in every pair

## Totals

Median wall-clock `analyze` time, with the range over the runs. Per warm run, *entries found* counts services whose entry was under their key (their own files unchanged), and *services collected* counts entries written: services analyzed afresh, because their entry was missing or an input it recorded elsewhere (e.g. an imported package's file) changed.

| Case | Edited file | Cold | Warm | Warm ÷ cold | Entries found | Services collected | Same bytes |
|---|---|---:|---:|---:|---:|---:|---|
| Nothing changed | none | 34,314 ms (32,556 ms to 34,927 ms) | 8,358 ms (8,317 ms to 9,019 ms) | 24% | 113 | 0 | yes |
| One leaf app edited | `apps/api/v2/src/main.ts` | 38,560 ms (34,409 ms to 39,188 ms) | 16,232 ms (15,152 ms to 17,351 ms) | 42% | 112 | 1 | yes |
| A shared package edited | `packages/lib/constants.ts` | 39,267 ms (36,723 ms to 39,934 ms) | 47,019 ms (43,693 ms to 50,245 ms) | 120% | 112 | 88 | yes |

## Peak RSS

| Case | Cold | Warm |
|---|---:|---:|
| Nothing changed | 2303 MiB (2169 MiB to 2308 MiB) | 417 MiB (400 MiB to 417 MiB) |
| One leaf app edited | 2177 MiB (2059 MiB to 2303 MiB) | 845 MiB (843 MiB to 879 MiB) |
| A shared package edited | 2305 MiB (2171 MiB to 2310 MiB) | 2147 MiB (2076 MiB to 2385 MiB) |

## Per stage

Median milliseconds. A warm run that reuses every service builds no program, so its detector stages only compose.

| Stage | Nothing changed: cold | Nothing changed: warm | One leaf app edited: cold | One leaf app edited: warm | A shared package edited: cold | A shared package edited: warm |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 3,179 ms | 3,168 ms | 3,760 ms | 3,251 ms | 4,076 ms | 3,917 ms |
| workspace | 28 ms | 26 ms | 28 ms | 28 ms | 32 ms | 31 ms |
| programs | 11,971 ms | 2,375 ms | 13,212 ms | 4,051 ms | 13,594 ms | 14,967 ms |
| imports | 1,928 ms | 25 ms | 2,111 ms | 218 ms | 2,199 ms | 2,213 ms |
| express | 42 ms | 2 ms | 45 ms | 9 ms | 45 ms | 42 ms |
| next | 673 ms | 0 ms | 739 ms | 1 ms | 749 ms | 744 ms |
| prisma | 1,123 ms | 17 ms | 1,242 ms | 399 ms | 1,240 ms | 1,279 ms |
| infra | 30 ms | 32 ms | 35 ms | 35 ms | 37 ms | 37 ms |
| files | 2,497 ms | 2,584 ms | 2,930 ms | 3,080 ms | 3,242 ms | 3,070 ms |
| symbols | 57 ms | 0 ms | 52 ms | 10 ms | 60 ms | 55 ms |
| calls | 4,674 ms | 12 ms | 4,939 ms | 3,235 ms | 5,276 ms | 5,380 ms |
| http | 3,998 ms | 13 ms | 4,342 ms | 685 ms | 4,392 ms | 4,621 ms |
| sdk | 1,352 ms | 0 ms | 1,422 ms | 216 ms | 1,497 ms | 1,484 ms |
| queues | 2,064 ms | 0 ms | 2,194 ms | 356 ms | 2,324 ms | 2,202 ms |
| assemble | 305 ms | 252 ms | 331 ms | 310 ms | 350 ms | 333 ms |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **Rendering:** measured with gitinside `681a893`. The first rendering printed the cache's hits and misses as if they were services reused and collected; this report was then re-rendered from the same JSON with the *entries found* and *services collected* (entries written) columns, numbers untouched. The renderer change is committed with this report.
- **Unchanged repo: 4.1× faster.** A warm run that reuses all 113 services takes 8.4 s against 34.3 s cold (24%), with the same bytes in every pair. It builds no program and its detectors only compose (0–25 ms each). What's left is the global work every run does: `inventory` (3.2 s, walking and hashing the tree), `files` (2.6 s), `programs` (2.4 s, here computing the keys and checking 113 entries' recorded inputs), and `assemble` (0.25 s). Those three stages are the floor for any warm run on this repo and the next thing to cut.
- **A leaf app edited: 2.4× faster.** Editing `apps/api/v2/src/main.ts` collects one service (`apps/api/v2`) and reuses 112: 16.2 s against 38.6 s cold (42%). On top of the floor, the one service's work shows in `programs` (4.1 s), `calls` (3.2 s), and `http` (0.7 s): `apps/api/v2` is a large NestJS app; a smaller app's edit wasn't measured. Untimed work (hashing its inputs, writing its entry) took 78–101 ms.
- **A shared package edited: 1.2× slower than cold.** 88 of the 113 services' entries recorded `packages/lib/constants.ts` among their inputs, so 88 are collected and only 25 reused: 47.0 s against 39.3 s cold (120%). The stages themselves sum to about cold's (`programs` 15.0 s vs 13.6 s, the rest within noise), so the 25 reused services save little. The extra time is outside every stage: after `queues`, the run hashes the collected services' recorded inputs and writes their 88 entries, 5.2 to 6.3 s per run (cold runs: 3 to 5 ms). The fill run spent 5.0 s there writing all 113 (36.9 s against 34.3 s cold). So when an edit reaches most services, the cache costs more than it saves; storing those entries is what makes the next run fast, and a job could skip or defer it (e.g. not store when most services were collected, or write after answering). Not changed in this task; follow-up M6.8b, and real commits hit this case nine times in ten (`2026-11-02-incremental-calcom-commits.md`).
- **Memory follows the work.** Peak RSS is 417 MiB for an unchanged warm run against 2.3 GiB cold, 845 MiB for the leaf edit, and 2.1 GiB for the shared edit. A warm job leaves most of Cloud Run's 4 GiB unused (ADR-0146's budget is sized for the cold run).
- **Noise.** Cold medians on the same tree range 32.6 to 39.9 s across cases (an appended constant changes almost nothing, so most of that is the machine; each later case's cold runs were slower). Each case's pairs alternate cold-first and warm-first, so drift hits both sides. The gaps above (26 s, 22 s, 8 s) are larger than the within-case ranges (at most 6.6 s).
- **Not measured:** Linux, Cloud Run's 1 vCPU, and the worker's in-memory `/tmp` cache (64 MiB cap, ADR-0178; this run's cache folder had the default 2 GB cap, and its 25 MiB fits either). A PR's base and head (M8's diff jobs) are the case M6.7's cache targets; this report measures one commit against a one-file edit of it.
