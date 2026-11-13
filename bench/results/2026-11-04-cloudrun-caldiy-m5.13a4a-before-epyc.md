# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `e19589d3e5c856c2bf40316428aa4c4a91837c74`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V45 96-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.1 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 39.0 s | 2.2 s | 35.7 s | 2,117 MiB | 1,981 MiB | 2,410 MiB | 37.8 s | 33.4 s |
| 2 | 38.5 s | 2.2 s | 35.8 s | 2,115 MiB | 1,976 MiB | 2,405 MiB | 38.0 s | 34.5 s |
| 3 | 38.4 s | 2.3 s | 35.6 s | 2,118 MiB | 1,980 MiB | 2,413 MiB | 37.9 s | 33.7 s |

**Median analysis: 35.7 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 0.7 s | 0.7 s | 0.7 s | 0.7 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 9.5 s | 9.3 s | 9.5 s | 9.5 s |
| imports | 2.0 s | 2.0 s | 2.0 s | 2.0 s |
| express | 0.0 s | 0.1 s | 0.1 s | 0.1 s |
| next | 1.5 s | 1.5 s | 1.4 s | 1.5 s |
| prisma | 1.8 s | 1.8 s | 1.8 s | 1.8 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.0 s | 0.1 s |
| symbols | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| calls | 9.6 s | 9.7 s | 9.5 s | 9.6 s |
| http | 5.1 s | 5.2 s | 5.2 s | 5.2 s |
| sdk | 1.5 s | 1.5 s | 1.5 s | 1.5 s |
| queues | 2.2 s | 2.2 s | 2.2 s | 2.2 s |
| assemble | 0.4 s | 0.4 s | 0.4 s | 0.4 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
