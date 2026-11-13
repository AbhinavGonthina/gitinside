# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `b7e5a596e6b2847567ab5896ec071117aa2c16f1`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 10 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 10.1 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 63.7 s | 4.4 s | 58.1 s | 7.6 s (7.2 s) | 1,941 MiB | 1,803 MiB | 2,220 MiB | 62.5 s | 53.4 s |
| 2 | 32 MiB | 63.9 s | 4.3 s | 58.5 s | 6.4 s (6.1 s) | 1,970 MiB | 1,830 MiB | 2,251 MiB | 62.9 s | 57.4 s |
| 3 | default | 64.3 s | 4.4 s | 58.9 s | 8.1 s (7.6 s) | 1,938 MiB | 1,803 MiB | 2,221 MiB | 63.3 s | 54.1 s |
| 4 | 32 MiB | 64.3 s | 4.3 s | 58.9 s | 6.3 s (6.1 s) | 1,983 MiB | 1,832 MiB | 2,266 MiB | 63.3 s | 57.1 s |
| 5 | default | 65.3 s | 4.4 s | 59.9 s | 8.4 s (7.9 s) | 1,939 MiB | 1,803 MiB | 2,218 MiB | 64.3 s | 54.6 s |
| 6 | 32 MiB | 64.2 s | 4.4 s | 58.8 s | 6.5 s (6.0 s) | 1,987 MiB | 1,833 MiB | 2,265 MiB | 63.3 s | 58.0 s |
| 7 | default | 65.1 s | 4.4 s | 59.6 s | 8.5 s (8.1 s) | 1,941 MiB | 1,803 MiB | 2,215 MiB | 64.0 s | 54.8 s |
| 8 | 32 MiB | 63.9 s | 4.4 s | 58.5 s | 6.9 s (6.2 s) | 1,967 MiB | 1,831 MiB | 2,246 MiB | 62.9 s | 58.3 s |
| 9 | default | 64.0 s | 4.3 s | 58.7 s | 8.3 s (7.9 s) | 1,940 MiB | 1,802 MiB | 2,222 MiB | 63.0 s | 55.5 s |
| 10 | 32 MiB | 62.4 s | 4.3 s | 57.1 s | 5.9 s (5.6 s) | 1,974 MiB | 1,826 MiB | 2,256 MiB | 61.5 s | 56.4 s |

## By semi-space cap (runs alternate between them; DESIGN.md §9's budget is ≤ 60.0 s)

| Semi-space | Finished runs | Median analysis | Against the budget | Median GC pauses (minor) | Median final heap (child) | Median container memory peak |
|---|---:|---:|---|---:|---:|---:|
| default | 5 | 58.9 s | within | 8.3 s (7.9 s) | 1,803 MiB | 2,220 MiB |
| 32 MiB | 5 | 58.5 s | within | 6.4 s (6.1 s) | 1,831 MiB | 2,256 MiB |

## Stages

| Stage | Run 1 (default) | Run 2 (32 MiB) | Run 3 (default) | Run 4 (32 MiB) | Run 5 (default) | Run 6 (32 MiB) | Run 7 (default) | Run 8 (32 MiB) | Run 9 (default) | Run 10 (32 MiB) | Median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inventory | 1.4 s | 1.4 s | 1.5 s | 1.3 s | 1.5 s | 1.5 s | 1.5 s | 1.4 s | 1.4 s | 1.4 s | 1.4 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.1 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 15.7 s | 15.1 s | 15.3 s | 15.5 s | 15.9 s | 15.5 s | 15.7 s | 15.7 s | 15.8 s | 15.0 s | 15.6 s |
| imports | 3.4 s | 3.3 s | 3.2 s | 3.2 s | 3.4 s | 3.2 s | 3.4 s | 3.3 s | 3.3 s | 3.3 s | 3.3 s |
| express | 0.1 s | 0.1 s | 0.2 s | 0.2 s | 0.1 s | 0.2 s | 0.1 s | 0.1 s | 0.2 s | 0.1 s | 0.1 s |
| next | 2.3 s | 2.2 s | 2.2 s | 2.2 s | 2.2 s | 2.2 s | 2.3 s | 2.2 s | 2.2 s | 2.2 s | 2.2 s |
| prisma | 2.7 s | 2.7 s | 2.6 s | 2.7 s | 2.7 s | 2.7 s | 2.6 s | 2.7 s | 2.7 s | 2.7 s | 2.7 s |
| infra | 0.1 s | 0.1 s | 0.0 s | 0.0 s | 0.1 s | 0.0 s | 0.1 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 15.1 s | 15.6 s | 15.6 s | 12.9 s | 15.7 s | 12.9 s | 15.5 s | 15.6 s | 15.3 s | 15.0 s | 15.4 s |
| http | 8.6 s | 8.9 s | 8.9 s | 11.7 s | 9.1 s | 11.6 s | 9.1 s | 8.7 s | 8.7 s | 8.6 s | 8.9 s |
| sdk | 2.4 s | 2.5 s | 2.6 s | 2.5 s | 2.6 s | 2.5 s | 2.6 s | 2.4 s | 2.6 s | 2.4 s | 2.5 s |
| queues | 3.6 s | 3.9 s | 3.8 s | 3.7 s | 3.8 s | 3.7 s | 3.7 s | 3.6 s | 3.7 s | 3.7 s | 3.7 s |
| assemble | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
