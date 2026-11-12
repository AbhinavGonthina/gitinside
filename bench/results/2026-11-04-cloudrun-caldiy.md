# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `d47f4638b45f33ed1cef17a5b27e47c835b515f2`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: INTEL(R) XEON(R) PLATINUM 8573C (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.7 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes
- **Workflow run:** [41781984308](https://github.com/AbhinavGonthina/gitinside/actions/runs/41781984308) ("Benchmark (1 vCPU)", `.github/workflows/bench-cloudrun.yml`), artifact `cloudrun-bench`, copied here unchanged above the observations.

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 49.0 s | 3.1 s | 44.4 s | 2,115 MiB | 1,979 MiB | 2,405 MiB | 47.4 s | 44.8 s |
| 2 | 48.1 s | 3.1 s | 44.3 s | 2,110 MiB | 1,974 MiB | 2,393 MiB | 47.3 s | 42.3 s |
| 3 | 48.0 s | 3.1 s | 44.2 s | 2,113 MiB | 1,975 MiB | 2,406 MiB | 47.2 s | 44.7 s |

**Median analysis: 44.3 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 0.9 s | 1.0 s | 0.9 s | 0.9 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 11.9 s | 12.0 s | 12.1 s | 12.0 s |
| imports | 2.4 s | 2.3 s | 2.2 s | 2.3 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 1.7 s | 1.6 s | 1.7 s | 1.7 s |
| prisma | 2.1 s | 2.1 s | 2.0 s | 2.1 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.1 s | 0.1 s | 0.2 s | 0.1 s |
| calls | 12.5 s | 12.3 s | 12.3 s | 12.3 s |
| http | 6.3 s | 6.3 s | 6.3 s | 6.3 s |
| sdk | 1.8 s | 1.8 s | 1.8 s | 1.8 s |
| queues | 2.6 s | 2.7 s | 2.6 s | 2.6 s |
| assemble | 0.5 s | 0.5 s | 0.5 s | 0.5 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **On this 1-vCPU container the analysis is within budget: 44.2–44.4 s**, three runs within 0.2 s of each other (the laptop's 8 runs of the same commit spread over 48–92 s, `2026-11-04-caldiy-stages.md`). Each stage also repeats to within 0.2 s, so this workflow can measure a change of a second or two, which the laptop can't. Extraction adds 3.1 s, and starting and stopping the container 0.7–1.5 s (container time minus extraction and analysis).
- **The laptop mostly ran slower than one CI vCPU.** Its 8 runs had a median of 84.6 s and only one (the profiled run, 47.9 s) came near this 44.3 s; here `programs` took 12.0 s against the laptop's 15.1–24.5 s. The laptop is Windows with other programs open; this report doesn't measure why, but it means a laptop timing is neither a lower nor an upper bound for Cloud Run.
- **The container is CPU-bound for the whole run.** It used 47.2–47.4 s of CPU in 48.0–49.0 s, and was throttled in 458 of ~475 scheduling periods (100 ms each; `cpu.stat` `nr_throttled` in the JSON): something besides the main thread (V8's helper threads, e.g. the collector's) wanted CPU in nearly every period, and with a 1-vCPU quota that time comes out of the analysis. The 44.8 s "CPU throttled" column is the cgroup's `throttled_usec`, wall time spent waiting at the quota, not CPU used.
- **Memory fits the 4 GiB instance with room:** the container peaked at 2,393–2,406 MiB including the 203 MiB unpacked repo in `/tmp`; the child's final heap was 1,974–1,979 MiB, 81% of the 2,560 MB (2,441 MiB) cap, its peak RSS 2,110–2,115 MiB.
- **Production's 96.3 s isn't explained by the analysis alone.** If Cloud Run's vCPU matched this runner's, 44.3 s of analysis plus 3.1 s of extraction leaves about 49 s for Cloud Tasks dispatch, the instance's cold start, the 155 MiB download from GitHub (7.7 s from the runner), and the upload; or Cloud Run's vCPU is slower than this Xeon Platinum 8573C's. Production's own split (`analyses.stats.stageMs` and `jobMs`, planning#20) tells which; until then this is the analysis's number on a known 1-vCPU machine, not production's.
- **What this changes for the next steps:** M5.13a4 (parse each file once) and M5.13a5 (the collector) are no longer needed to meet the 60 s analysis budget on this machine, but `programs` (12.0 s) and the checker-driven `calls` and `http` (18.6 s together) are still where the time goes, the heap is at 81% of its cap, and the CPU is saturated, so they still buy margin for slower vCPUs and bigger repos. Measure them with this workflow (`gh workflow run "Benchmark (1 vCPU)"`), before and after, on the same runner type.
