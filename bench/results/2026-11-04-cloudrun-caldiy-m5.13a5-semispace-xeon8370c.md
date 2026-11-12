# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `626ba13858674fce0b6709131f9bab88732d66b7`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 9 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.6 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 59.5 s | 3.5 s | 54.9 s | 7.7 s (7.2 s) | 1,939 MiB | 1,803 MiB | 2,220 MiB | 58.3 s | 53.8 s |
| 2 | 32 MiB | 58.2 s | 3.4 s | 53.9 s | 6.1 s (5.6 s) | 1,968 MiB | 1,829 MiB | 2,246 MiB | 57.4 s | 55.0 s |
| 3 | 64 MiB | 58.1 s | 3.5 s | 53.7 s | 5.6 s (5.1 s) | 2,084 MiB | 1,923 MiB | 2,369 MiB | 57.2 s | 57.3 s |
| 4 | default | 59.3 s | 3.5 s | 54.9 s | 7.9 s (7.5 s) | 1,940 MiB | 1,803 MiB | 2,217 MiB | 58.4 s | 52.8 s |
| 5 | 32 MiB | 58.7 s | 3.5 s | 54.3 s | 6.2 s (5.3 s) | 1,966 MiB | 1,829 MiB | 2,246 MiB | 57.8 s | 54.9 s |
| 6 | 64 MiB | 58.1 s | 3.5 s | 53.7 s | 5.3 s (4.8 s) | 2,027 MiB | 1,889 MiB | 2,314 MiB | 57.2 s | 56.9 s |
| 7 | default | 58.9 s | 3.4 s | 54.6 s | 7.9 s (7.4 s) | 1,941 MiB | 1,805 MiB | 2,220 MiB | 57.9 s | 52.4 s |
| 8 | 32 MiB | 58.1 s | 3.5 s | 53.7 s | 6.2 s (5.6 s) | 1,968 MiB | 1,830 MiB | 2,249 MiB | 57.2 s | 53.4 s |
| 9 | 64 MiB | 58.3 s | 3.5 s | 54.0 s | 5.2 s (4.5 s) | 2,082 MiB | 1,928 MiB | 2,366 MiB | 57.5 s | 57.5 s |

## By semi-space cap (runs alternate between them; DESIGN.md §9's budget is ≤ 60.0 s)

| Semi-space | Finished runs | Median analysis | Against the budget | Median GC pauses (minor) | Median final heap (child) | Median container memory peak |
|---|---:|---:|---|---:|---:|---:|
| default | 3 | 54.9 s | within | 7.9 s (7.4 s) | 1,803 MiB | 2,220 MiB |
| 32 MiB | 3 | 53.9 s | within | 6.2 s (5.6 s) | 1,829 MiB | 2,246 MiB |
| 64 MiB | 3 | 53.7 s | within | 5.3 s (4.8 s) | 1,923 MiB | 2,366 MiB |

## Stages

| Stage | Run 1 (default) | Run 2 (32 MiB) | Run 3 (64 MiB) | Run 4 (default) | Run 5 (32 MiB) | Run 6 (64 MiB) | Run 7 (default) | Run 8 (32 MiB) | Run 9 (64 MiB) | Median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inventory | 1.1 s | 1.1 s | 1.1 s | 1.1 s | 1.1 s | 1.1 s | 1.1 s | 1.0 s | 1.1 s | 1.1 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 14.5 s | 14.5 s | 14.4 s | 14.5 s | 14.7 s | 14.3 s | 14.5 s | 14.3 s | 14.6 s | 14.5 s |
| imports | 3.1 s | 2.9 s | 2.9 s | 3.0 s | 3.0 s | 2.9 s | 3.0 s | 3.0 s | 2.9 s | 3.0 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 2.1 s | 2.0 s | 2.0 s | 2.1 s | 2.0 s | 2.0 s | 2.0 s | 2.0 s | 2.0 s | 2.0 s |
| prisma | 2.5 s | 2.4 s | 2.4 s | 2.4 s | 2.4 s | 2.4 s | 2.5 s | 2.4 s | 2.4 s | 2.4 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.1 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 15.3 s | 15.1 s | 12.0 s | 15.4 s | 15.0 s | 15.2 s | 15.2 s | 14.9 s | 12.0 s | 15.1 s |
| http | 8.0 s | 8.0 s | 10.9 s | 8.1 s | 8.1 s | 7.8 s | 8.1 s | 8.0 s | 10.9 s | 8.1 s |
| sdk | 2.3 s | 2.1 s | 2.1 s | 2.3 s | 2.2 s | 2.1 s | 2.2 s | 2.2 s | 2.2 s | 2.2 s |
| queues | 3.3 s | 3.2 s | 3.1 s | 3.3 s | 3.2 s | 3.2 s | 3.3 s | 3.2 s | 3.2 s | 3.2 s |
| assemble | 0.7 s | 0.6 s | 0.7 s | 0.7 s | 0.6 s | 0.6 s | 0.7 s | 0.7 s | 0.6 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
