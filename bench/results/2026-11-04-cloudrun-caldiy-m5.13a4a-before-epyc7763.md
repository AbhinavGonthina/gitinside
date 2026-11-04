# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `9521be66fb836f94f6ec5db6251da1a4f7f8820e`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 86.0 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 7763 64-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 3.2 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 62.7 s | 4.2 s | 57.3 s | 2,112 MiB | 1,976 MiB | 2,395 MiB | 61.4 s | 48.3 s |
| 2 | 62.9 s | 4.2 s | 57.7 s | 2,113 MiB | 1,975 MiB | 2,401 MiB | 61.9 s | 53.3 s |
| 3 | 61.4 s | 4.2 s | 56.3 s | 2,112 MiB | 1,976 MiB | 2,398 MiB | 60.4 s | 50.7 s |

**Median analysis: 57.3 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.4 s | 1.4 s | 1.5 s | 1.4 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 15.5 s | 15.7 s | 15.5 s | 15.5 s |
| imports | 3.2 s | 3.1 s | 3.1 s | 3.1 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 2.2 s | 2.2 s | 2.1 s | 2.2 s |
| prisma | 2.7 s | 2.7 s | 2.6 s | 2.7 s |
| infra | 0.0 s | 0.1 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.2 s | 0.2 s | 0.2 s |
| calls | 15.0 s | 14.9 s | 14.6 s | 14.9 s |
| http | 8.4 s | 8.7 s | 8.3 s | 8.4 s |
| sdk | 2.4 s | 2.4 s | 2.3 s | 2.4 s |
| queues | 3.6 s | 3.5 s | 3.4 s | 3.5 s |
| assemble | 0.7 s | 0.6 s | 0.7 s | 0.7 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
