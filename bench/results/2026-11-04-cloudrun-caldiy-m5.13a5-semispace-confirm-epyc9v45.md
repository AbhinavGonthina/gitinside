# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `626ba13858674fce0b6709131f9bab88732d66b7`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 10 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V45 96-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.2 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 37.3 s | 2.1 s | 34.1 s | 5.9 s (5.7 s) | 1,937 MiB | 1,800 MiB | 2,219 MiB | 36.1 s | 32.0 s |
| 2 | 32 MiB | 36.6 s | 2.1 s | 34.0 s | 5.0 s (4.7 s) | 2,011 MiB | 1,829 MiB | 2,292 MiB | 36.1 s | 34.3 s |
| 3 | default | 36.2 s | 2.1 s | 33.7 s | 5.7 s (5.5 s) | 1,947 MiB | 1,809 MiB | 2,226 MiB | 35.7 s | 33.6 s |
| 4 | 32 MiB | 36.4 s | 2.1 s | 33.8 s | 5.0 s (4.6 s) | 1,984 MiB | 1,831 MiB | 2,264 MiB | 35.9 s | 34.4 s |
| 5 | default | 36.5 s | 2.1 s | 33.8 s | 6.0 s (5.8 s) | 1,941 MiB | 1,806 MiB | 2,218 MiB | 35.9 s | 32.8 s |
| 6 | 32 MiB | 36.2 s | 2.1 s | 33.6 s | 4.6 s (4.3 s) | 1,980 MiB | 1,826 MiB | 2,266 MiB | 35.7 s | 33.8 s |
| 7 | default | 36.5 s | 2.1 s | 33.9 s | 5.9 s (5.7 s) | 1,944 MiB | 1,809 MiB | 2,220 MiB | 35.9 s | 33.0 s |
| 8 | 32 MiB | 36.3 s | 2.1 s | 33.7 s | 5.4 s (5.2 s) | 1,971 MiB | 1,824 MiB | 2,248 MiB | 35.8 s | 34.2 s |
| 9 | default | 36.5 s | 2.1 s | 33.9 s | 5.8 s (5.6 s) | 1,941 MiB | 1,805 MiB | 2,221 MiB | 35.9 s | 31.4 s |
| 10 | 32 MiB | 36.3 s | 2.1 s | 33.7 s | 4.9 s (4.8 s) | 1,980 MiB | 1,829 MiB | 2,262 MiB | 35.8 s | 32.9 s |

## By semi-space cap (runs alternate between them; DESIGN.md §9's budget is ≤ 60.0 s)

| Semi-space | Finished runs | Median analysis | Against the budget | Median GC pauses (minor) | Median final heap (child) | Median container memory peak |
|---|---:|---:|---|---:|---:|---:|
| default | 5 | 33.9 s | within | 5.9 s (5.7 s) | 1,806 MiB | 2,220 MiB |
| 32 MiB | 5 | 33.7 s | within | 5.0 s (4.7 s) | 1,829 MiB | 2,264 MiB |

## Stages

| Stage | Run 1 (default) | Run 2 (32 MiB) | Run 3 (default) | Run 4 (32 MiB) | Run 5 (default) | Run 6 (32 MiB) | Run 7 (default) | Run 8 (32 MiB) | Run 9 (default) | Run 10 (32 MiB) | Median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| inventory | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.7 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 8.7 s | 8.9 s | 8.6 s | 8.8 s | 8.6 s | 8.9 s | 8.6 s | 8.7 s | 8.7 s | 8.8 s | 8.7 s |
| imports | 2.0 s | 1.9 s | 1.9 s | 1.9 s | 2.0 s | 1.9 s | 2.0 s | 1.9 s | 1.9 s | 1.9 s | 1.9 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.0 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 1.3 s | 1.4 s | 1.4 s | 1.4 s | 1.4 s | 1.3 s | 1.4 s | 1.3 s | 1.4 s | 1.4 s | 1.4 s |
| prisma | 1.6 s | 1.6 s | 1.7 s | 1.6 s | 1.7 s | 1.7 s | 1.7 s | 1.7 s | 1.6 s | 1.7 s | 1.7 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.1 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.0 s | 0.1 s | 0.1 s | 0.0 s | 0.1 s | 0.1 s | 0.0 s | 0.0 s | 0.1 s |
| symbols | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.2 s | 0.1 s | 0.1 s |
| calls | 9.1 s | 7.2 s | 9.1 s | 7.3 s | 9.1 s | 7.2 s | 9.2 s | 9.0 s | 9.1 s | 8.9 s | 9.0 s |
| http | 5.2 s | 6.8 s | 4.9 s | 6.7 s | 5.0 s | 6.7 s | 5.0 s | 4.9 s | 5.0 s | 5.0 s | 5.0 s |
| sdk | 1.5 s | 1.4 s | 1.4 s | 1.4 s | 1.5 s | 1.4 s | 1.4 s | 1.4 s | 1.5 s | 1.4 s | 1.4 s |
| queues | 2.2 s | 2.2 s | 2.2 s | 2.2 s | 2.1 s | 2.1 s | 2.2 s | 2.1 s | 2.1 s | 2.1 s | 2.2 s |
| assemble | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s | 0.4 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
