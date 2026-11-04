# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `9521be66fb836f94f6ec5db6251da1a4f7f8820e`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.4 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 63.0 s | 4.3 s | 57.2 s | 2,116 MiB | 1,981 MiB | 2,405 MiB | 61.5 s | 53.2 s |
| 2 | 62.6 s | 4.3 s | 57.5 s | 2,118 MiB | 1,980 MiB | 2,401 MiB | 61.7 s | 50.0 s |
| 3 | 63.0 s | 4.3 s | 57.7 s | 2,115 MiB | 1,979 MiB | 2,399 MiB | 62.0 s | 51.0 s |

**Median analysis: 57.5 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.4 s | 1.4 s | 1.3 s | 1.4 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 15.8 s | 15.4 s | 15.4 s | 15.4 s |
| imports | 3.2 s | 3.2 s | 3.2 s | 3.2 s |
| express | 0.1 s | 0.1 s | 0.2 s | 0.1 s |
| next | 2.2 s | 2.1 s | 2.1 s | 2.1 s |
| prisma | 2.7 s | 2.7 s | 2.7 s | 2.7 s |
| infra | 0.0 s | 0.1 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 14.9 s | 14.9 s | 15.1 s | 14.9 s |
| http | 8.3 s | 8.7 s | 8.7 s | 8.7 s |
| sdk | 2.4 s | 2.5 s | 2.4 s | 2.4 s |
| queues | 3.4 s | 3.6 s | 3.7 s | 3.6 s |
| assemble | 0.7 s | 0.7 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
