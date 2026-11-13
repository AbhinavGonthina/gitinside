# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `c13c7a6d8d0ff9e8d3592a8d4861aaee04e5ab21`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 6.8 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 60.2 s | 4.2 s | 54.8 s | 1,941 MiB | 1,806 MiB | 2,224 MiB | 59.0 s | 51.0 s |
| 2 | 60.6 s | 4.2 s | 55.4 s | 1,972 MiB | 1,808 MiB | 2,255 MiB | 59.6 s | 51.2 s |
| 3 | 60.7 s | 4.2 s | 55.5 s | 1,942 MiB | 1,807 MiB | 2,224 MiB | 59.7 s | 49.4 s |

**Median analysis: 55.4 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.3 s | 1.4 s | 1.4 s | 1.4 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 14.4 s | 14.4 s | 14.3 s | 14.4 s |
| imports | 3.1 s | 3.1 s | 3.2 s | 3.1 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 2.1 s | 2.1 s | 2.2 s | 2.1 s |
| prisma | 2.5 s | 2.5 s | 2.5 s | 2.5 s |
| infra | 0.0 s | 0.1 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 14.5 s | 14.8 s | 14.7 s | 14.7 s |
| http | 8.2 s | 8.3 s | 8.5 s | 8.3 s |
| sdk | 2.3 s | 2.4 s | 2.4 s | 2.4 s |
| queues | 3.5 s | 3.5 s | 3.5 s | 3.5 s |
| assemble | 0.7 s | 0.6 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
