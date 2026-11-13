# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `e19589d3e5c856c2bf40316428aa4c4a91837c74`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.0 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 62.8 s | 3.6 s | 58.1 s | 2,115 MiB | 1,977 MiB | 2,399 MiB | 61.6 s | 56.7 s |
| 2 | 63.4 s | 3.6 s | 58.9 s | 2,114 MiB | 1,978 MiB | 2,397 MiB | 62.5 s | 58.2 s |
| 3 | 62.9 s | 3.5 s | 58.5 s | 2,111 MiB | 1,975 MiB | 2,394 MiB | 61.9 s | 55.5 s |

**Median analysis: 58.5 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.1 s | 1.1 s | 1.1 s | 1.1 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 16.1 s | 16.6 s | 16.2 s | 16.2 s |
| imports | 3.2 s | 3.2 s | 3.2 s | 3.2 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 2.1 s | 2.2 s | 2.2 s | 2.2 s |
| prisma | 2.7 s | 2.6 s | 2.6 s | 2.6 s |
| infra | 0.0 s | 0.0 s | 0.1 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 15.8 s | 16.3 s | 16.0 s | 16.0 s |
| http | 8.3 s | 8.4 s | 8.2 s | 8.3 s |
| sdk | 2.4 s | 2.3 s | 2.3 s | 2.3 s |
| queues | 3.5 s | 3.4 s | 3.5 s | 3.5 s |
| assemble | 0.7 s | 0.7 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
