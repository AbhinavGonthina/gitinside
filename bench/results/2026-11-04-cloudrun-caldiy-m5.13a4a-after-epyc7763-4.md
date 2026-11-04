# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `c7e14a60c82e3a20544d3d692bbcdc37c6b9d1b9`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 1.7 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 59.2 s | 4.0 s | 53.7 s | 1,944 MiB | 1,808 MiB | 2,223 MiB | 57.7 s | 47.7 s |
| 2 | 58.7 s | 4.0 s | 53.7 s | 1,945 MiB | 1,808 MiB | 2,226 MiB | 57.8 s | 50.8 s |
| 3 | 58.6 s | 4.0 s | 53.7 s | 1,945 MiB | 1,807 MiB | 2,227 MiB | 57.7 s | 49.0 s |

**Median analysis: 53.7 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.4 s | 1.3 s | 1.3 s | 1.3 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 13.6 s | 14.0 s | 13.8 s | 13.8 s |
| imports | 3.0 s | 3.0 s | 3.0 s | 3.0 s |
| express | 0.1 s | 0.2 s | 0.1 s | 0.1 s |
| next | 2.1 s | 2.1 s | 2.1 s | 2.1 s |
| prisma | 2.4 s | 2.4 s | 2.4 s | 2.4 s |
| infra | 0.1 s | 0.0 s | 0.1 s | 0.1 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 14.3 s | 14.3 s | 14.4 s | 14.3 s |
| http | 8.2 s | 8.1 s | 8.0 s | 8.1 s |
| sdk | 2.3 s | 2.3 s | 2.4 s | 2.3 s |
| queues | 3.5 s | 3.4 s | 3.4 s | 3.4 s |
| assemble | 0.6 s | 0.7 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
