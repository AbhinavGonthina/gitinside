# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `626ba13858674fce0b6709131f9bab88732d66b7`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 9 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V74 80-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.5 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 47.3 s | 3.0 s | 42.8 s | 6.7 s (6.4 s) | 1,937 MiB | 1,801 MiB | 2,219 MiB | 45.7 s | 41.4 s |
| 2 | 32 MiB | 46.3 s | 3.0 s | 42.5 s | 5.8 s (5.5 s) | 1,978 MiB | 1,826 MiB | 2,259 MiB | 45.5 s | 41.2 s |
| 3 | 64 MiB | 47.5 s | 3.0 s | 43.8 s | 5.2 s (4.7 s) | 2,079 MiB | 1,938 MiB | 2,367 MiB | 46.8 s | 43.5 s |
| 4 | default | 49.5 s | 3.0 s | 45.8 s | 7.6 s (7.4 s) | 1,943 MiB | 1,808 MiB | 2,227 MiB | 48.8 s | 42.6 s |
| 5 | 32 MiB | 49.0 s | 3.0 s | 45.1 s | 5.4 s (5.1 s) | 1,975 MiB | 1,828 MiB | 2,259 MiB | 48.2 s | 41.4 s |
| 6 | 64 MiB | 46.7 s | 3.0 s | 43.1 s | 4.8 s (4.3 s) | 2,082 MiB | 1,926 MiB | 2,371 MiB | 46.1 s | 43.3 s |
| 7 | default | 46.9 s | 3.0 s | 43.3 s | 7.0 s (6.5 s) | 1,942 MiB | 1,802 MiB | 2,219 MiB | 46.2 s | 41.4 s |
| 8 | 32 MiB | 46.3 s | 3.0 s | 42.6 s | 5.2 s (5.0 s) | 1,997 MiB | 1,834 MiB | 2,279 MiB | 45.6 s | 42.5 s |
| 9 | 64 MiB | 46.3 s | 2.9 s | 42.7 s | 4.6 s (4.1 s) | 2,079 MiB | 1,934 MiB | 2,360 MiB | 45.6 s | 41.9 s |

## By semi-space cap (runs alternate between them; DESIGN.md §9's budget is ≤ 60.0 s)

| Semi-space | Finished runs | Median analysis | Against the budget | Median GC pauses (minor) | Median final heap (child) | Median container memory peak |
|---|---:|---:|---|---:|---:|---:|
| default | 3 | 43.3 s | within | 7.0 s (6.5 s) | 1,802 MiB | 2,219 MiB |
| 32 MiB | 3 | 42.6 s | within | 5.4 s (5.1 s) | 1,828 MiB | 2,259 MiB |
| 64 MiB | 3 | 43.1 s | within | 4.8 s (4.3 s) | 1,934 MiB | 2,367 MiB |

## Stages

| Stage | Run 1 (default) | Run 2 (32 MiB) | Run 3 (64 MiB) | Run 4 (default) | Run 5 (32 MiB) | Run 6 (64 MiB) | Run 7 (default) | Run 8 (32 MiB) | Run 9 (64 MiB) | Median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inventory | 0.9 s | 0.9 s | 1.0 s | 0.9 s | 1.0 s | 1.0 s | 0.9 s | 1.0 s | 0.9 s | 0.9 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 11.0 s | 11.1 s | 11.5 s | 11.8 s | 11.6 s | 11.5 s | 11.3 s | 11.2 s | 11.2 s | 11.3 s |
| imports | 2.5 s | 2.5 s | 2.5 s | 2.7 s | 2.6 s | 2.5 s | 2.5 s | 2.5 s | 2.4 s | 2.5 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 1.6 s | 1.7 s | 1.7 s | 1.8 s | 1.7 s | 1.7 s | 1.7 s | 1.7 s | 1.7 s | 1.7 s |
| prisma | 2.0 s | 2.0 s | 2.1 s | 2.2 s | 2.2 s | 2.0 s | 2.0 s | 2.0 s | 2.0 s | 2.0 s |
| infra | 0.1 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.1 s | 0.1 s | 0.2 s | 0.1 s | 0.2 s | 0.2 s | 0.1 s | 0.1 s | 0.1 s |
| calls | 11.4 s | 11.2 s | 9.3 s | 12.1 s | 12.0 s | 8.9 s | 11.5 s | 9.0 s | 9.0 s | 11.2 s |
| http | 6.4 s | 6.3 s | 8.9 s | 6.7 s | 6.9 s | 8.6 s | 6.4 s | 8.5 s | 8.6 s | 6.9 s |
| sdk | 1.9 s | 1.8 s | 1.9 s | 2.0 s | 2.0 s | 1.8 s | 1.9 s | 1.9 s | 1.8 s | 1.9 s |
| queues | 2.8 s | 2.8 s | 2.7 s | 3.0 s | 2.9 s | 2.7 s | 2.8 s | 2.7 s | 2.7 s | 2.8 s |
| assemble | 0.5 s | 0.5 s | 0.5 s | 0.6 s | 0.5 s | 0.5 s | 0.5 s | 0.5 s | 0.5 s | 0.5 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
