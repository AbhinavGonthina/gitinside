# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-11)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.3.0 (gitinside `0e1bf7dafd82d04b1ceb531e133855b6c5043546`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.1 MB gzipped) started 5 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V74 80-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.1 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 54.4 s | 3.0 s | 49.4 s | 5.7 s (5.6 s) | 2,035 MiB | 1,897 MiB | 2,319 MiB | 52.4 s | 38.9 s |
| 2 | default | 53.0 s | 3.0 s | 49.2 s | 5.8 s (5.7 s) | 2,087 MiB | 1,097 MiB | 2,361 MiB | 52.2 s | 41.5 s |
| 3 | default | 53.4 s | 3.0 s | 49.6 s | 6.2 s (6.1 s) | 2,084 MiB | 1,133 MiB | 2,370 MiB | 52.6 s | 40.0 s |
| 4 | default | 53.7 s | 3.0 s | 49.9 s | 5.4 s (5.3 s) | 1,995 MiB | 1,859 MiB | 2,275 MiB | 52.9 s | 41.5 s |
| 5 | default | 52.8 s | 3.0 s | 49.1 s | 5.7 s (5.6 s) | 2,085 MiB | 1,102 MiB | 2,346 MiB | 52.2 s | 39.6 s |

**Median analysis: 49.4 s** over 5 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 0.9 s | 0.9 s | 0.9 s | 0.9 s | 0.9 s | 0.9 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 11.0 s | 10.8 s | 11.1 s | 11.4 s | 11.0 s | 11.0 s |
| imports | 7.4 s | 7.2 s | 7.3 s | 5.7 s | 7.3 s | 7.3 s |
| express | 0.2 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 0.0 s | 0.0 s | 0.1 s | 0.1 s | 0.0 s | 0.0 s |
| prisma | 1.4 s | 1.3 s | 1.3 s | 1.3 s | 1.4 s | 1.3 s |
| infra | 0.0 s | 0.1 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| files | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| symbols | 0.1 s | 0.2 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| calls | 12.4 s | 12.1 s | 12.1 s | 14.3 s | 11.9 s | 12.1 s |
| http | 9.3 s | 9.3 s | 9.2 s | 9.2 s | 9.1 s | 9.2 s |
| sdk | 1.8 s | 1.8 s | 1.8 s | 1.8 s | 1.8 s | 1.8 s |
| queues | 2.8 s | 2.8 s | 2.8 s | 2.9 s | 2.8 s | 2.8 s |
| assemble | 0.5 s | 0.6 s | 0.5 s | 0.6 s | 0.5 s | 0.5 s |

Graph (run 1): 5,075 files, 19,422 nodes, 31,779 edges, 710 unresolved, 157 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.
