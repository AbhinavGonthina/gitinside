# The collector on 1 vCPU: calcom/cal.diy (M5.13a5, 2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee` (5,043 files in the graph, 113 services), the commit M5.13a2–a4 used.
- **Code measured:** `main` at `6d90553` (ADR-0197's shared parses; the analysis child now reports its collector pauses). Before ADR-0198, so "default" below is V8's own semi-space: 16 MiB with the 2,560 MB heap cap on Node 22 (a 32 MiB new space, measured with `v8.getHeapSpaceStatistics()`; `--max-semi-space-size=64` gives 128 MiB).
- **Method:** the "Benchmark (1 vCPU)" workflow (M5.13a3: the worker image, `docker run --cpus 1 --memory 4g`, `/tmp` in memory, production's limits, no fact cache), with its new `semi_space` input. Each workflow run cycles through the caps run by run, so every cap is measured on the same runner. Comparing across runners doesn't work: runner CPU models differ by up to 13% (M5.13a4a). There were four workflow runs, each on a different CPU model. Two cycled default / 32 / 64 MiB (9 runs each), and two cycled default / 32 MiB (10 runs each) to check the first result.
- **Collector pauses:** the child sums its `gc` performance entries by kind (main-thread pauses only; V8's helper threads share the same one vCPU, but their work isn't counted here).
- **Raw reports:** `2026-11-04-cloudrun-caldiy-m5.13a5-semispace-{epyc9v74,xeon8370c,confirm-epyc9v45,confirm-epyc7763}.{md,json}` next to this file.

## Per runner (medians)

| Runner CPU | Semi-space | Runs | Analysis | GC pauses (minor) | Pauses / analysis | Final heap (child) | Container memory peak |
|---|---|---:|---:|---:|---:|---:|---:|
| AMD EPYC 9V74 | V8's 16 MiB | 3 | 43.3 s | 7.0 s (6.5 s) | 16% | 1,802 MiB | 2,219 MiB |
| | 32 MiB | 3 | 42.6 s | 5.4 s (5.1 s) | | 1,828 MiB | 2,259 MiB |
| | 64 MiB | 3 | 43.1 s | 4.8 s (4.3 s) | | 1,934 MiB | 2,367 MiB |
| Intel Xeon 8370C | V8's 16 MiB | 3 | 54.9 s | 7.9 s (7.4 s) | 14% | 1,803 MiB | 2,220 MiB |
| | 32 MiB | 3 | 53.9 s | 6.2 s (5.6 s) | | 1,829 MiB | 2,246 MiB |
| | 64 MiB | 3 | 53.7 s | 5.3 s (4.8 s) | | 1,923 MiB | 2,366 MiB |
| AMD EPYC 9V45 | V8's 16 MiB | 5 | 33.9 s | 5.9 s (5.7 s) | 17% | 1,806 MiB | 2,220 MiB |
| | 32 MiB | 5 | 33.7 s | 5.0 s (4.7 s) | | 1,829 MiB | 2,264 MiB |
| AMD EPYC 7763 | V8's 16 MiB | 5 | 58.9 s | 8.3 s (7.9 s) | 14% | 1,803 MiB | 2,220 MiB |
| | 32 MiB | 5 | 58.5 s | 6.4 s (6.1 s) | | 1,831 MiB | 2,256 MiB |

All 38 runs wrote the same graph (one SHA-256 across all four workflow runs), whatever the semi-space.

## Observations (hand-written, not generated)

- **The collector's main-thread share is 14–17% of the analysis** on every runner (5.9–8.3 s). 93–97% of it is minor (scavenge) pauses. Everything else (major, incremental, and weak-callback pauses) adds up to 0.2–0.5 s. This agrees with M5.13a2's laptop profile (12% of CPU).
- **A 32 MiB semi-space cuts the pauses by 15–23%** (0.9–1.9 s) on all four CPU models. **The analysis gets faster by much less:** the medians fell 0.2–1.0 s (0.6–1.8%). In paired runs (a default run and the 32 MiB run right after it), 32 MiB was faster in 13 of 16 pairs, tied in 1, and slower in 2 (by 0.1 and 0.4 s). Most of the saved pause time doesn't show up as saved wall-clock time. One explanation would be the program running a little slower between collections with a nursery twice the size, but that wasn't measured.
- **64 MiB is no better than 32 and costs four times as much memory.** It cut pauses a little more (4.8–5.3 s), but the analysis medians were 43.1 vs 42.6 s on EPYC 9V74 and 53.7 vs 53.9 s on Xeon 8370C. It also raised the final heap by 120–132 MiB and the container peak by 146–148 MiB, against 23–28 MiB and 26–44 MiB for 32 MiB.
- **Kept: 32 MiB (ADR-0198)**, because the task's rule was to keep a change only if it measured faster, and it did on every runner. The gain is small and is stated that way. The memory it adds fits inside `budget.ts`'s 256 MiB allowance for the child outside its heap.
- **The 60 s budget, analysis only:** 33.7–58.5 s at the 32 MiB medians, so it's met on all four CI CPU models. EPYC 7763 is close to the limit at 58.5 s, so the CPU model alone decides most of the margin. Production's 96.3 s end to end (M5.13) is mostly outside the analysis (dispatch, cold start, download, upload, or Cloud Run's vCPU), and splitting it needs production's own `analyses.stats` (gitinside-planning#20). The worker now writes `gcMs` there too.
