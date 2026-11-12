# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-04)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.2.0 (gitinside `4560e4d0833c335c66f99211d903814b8a9d394f`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.9 MB gzipped) started 3 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V74 80-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 6.6 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Container | Extraction | Analysis | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 47.7 s | 3.0 s | 43.3 s | 1,941 MiB | 1,804 MiB | 2,218 MiB | 46.3 s | 41.8 s |
| 2 | 47.1 s | 3.0 s | 43.4 s | 1,941 MiB | 1,804 MiB | 2,220 MiB | 46.4 s | 40.4 s |
| 3 | 47.0 s | 2.9 s | 43.3 s | 1,940 MiB | 1,802 MiB | 2,221 MiB | 46.2 s | 39.7 s |

**Median analysis: 43.3 s** over 3 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| inventory | 1.0 s | 1.0 s | 1.0 s | 1.0 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 11.3 s | 11.2 s | 10.9 s | 11.2 s |
| imports | 2.5 s | 2.5 s | 2.5 s | 2.5 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 1.6 s | 1.6 s | 1.7 s | 1.6 s |
| prisma | 2.1 s | 2.1 s | 2.0 s | 2.1 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.2 s | 0.1 s | 0.2 s | 0.2 s |
| calls | 11.3 s | 11.6 s | 11.4 s | 11.4 s |
| http | 6.4 s | 6.4 s | 6.5 s | 6.4 s |
| sdk | 1.9 s | 2.0 s | 1.9 s | 1.9 s |
| queues | 2.8 s | 2.9 s | 2.9 s | 2.9 s |
| assemble | 0.5 s | 0.5 s | 0.6 s | 0.5 s |

Graph (run 1): 5,043 files, 19,303 nodes, 31,544 edges, 720 unresolved, 144 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
