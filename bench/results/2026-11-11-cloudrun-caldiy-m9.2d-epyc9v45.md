# 1-vCPU analysis benchmark: calcom/cal.diy (2026-11-11)

- **Repo:** https://github.com/calcom/cal.diy at `2eb48eccd8aca8a0c0ffabf28cf92e298b33ecee`
- **Analyzer:** 0.3.0 (gitinside `d17b3b706bb15ecd76e847b358b535510cc99b23`)
- **Method:** the worker image (`apps/worker/Dockerfile`, 85.1 MB gzipped) started 5 times, a fresh container per run, as Cloud Run starts an instance: `docker run --cpus 1 --memory 4g --memory-swap 4g`, `/tmp` in memory, the image's user and working directory. Each run pipes GitHub's tarball (downloaded once, outside the container) into the image's `extractTarball` under `/tmp/jobs`, then the image's sandboxed `runAnalysis` with production's limits and no fact cache (a first analysis). Not included: Cloud Tasks dispatch, Cloud Run's cold start, the download, and the upload.
- **Host:** GitHub Actions Linux runner: AMD EPYC 9V45 96-Core Processor (4 host cores; the container's cgroup allows 1 vCPU), Node v22.18.0 in the image
- **Tarball:** 155 MiB gzipped (162.6 MB), downloaded in 7.9 s; 203 MiB unpacked, 7,703 files
- **Graphs identical across runs:** yes

## Runs

| Run | Semi-space | Container | Extraction | Analysis | GC pauses (minor) | Peak RSS (child) | Final heap (child) | Container memory peak | CPU used | CPU throttled |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | default | 47.0 s | 2.4 s | 42.9 s | 5.4 s (5.4 s) | 2,041 MiB | 1,903 MiB | 2,328 MiB | 45.4 s | 36.5 s |
| 2 | default | 45.3 s | 2.4 s | 42.3 s | 6.3 s (6.2 s) | 2,007 MiB | 1,867 MiB | 2,289 MiB | 44.7 s | 38.4 s |
| 3 | default | 43.9 s | 2.2 s | 41.1 s | 5.6 s (5.5 s) | 2,082 MiB | 1,105 MiB | 2,342 MiB | 43.3 s | 35.1 s |
| 4 | default | 45.0 s | 2.3 s | 42.2 s | 6.1 s (5.9 s) | 2,001 MiB | 1,861 MiB | 2,279 MiB | 44.5 s | 38.5 s |
| 5 | default | 46.8 s | 2.3 s | 43.8 s | 5.7 s (5.4 s) | 1,930 MiB | 1,169 MiB | 2,187 MiB | 46.2 s | 42.7 s |

**Median analysis: 42.3 s** over 5 finished runs, against DESIGN.md §9's ≤ 60.0 s for a 5k-file repo: within.

## Stages

| Stage | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---:|---:|---:|---:|---:|---:|
| inventory | 0.7 s | 0.7 s | 0.7 s | 0.7 s | 0.8 s | 0.7 s |
| workspace | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 0.0 s |
| programs | 9.7 s | 9.6 s | 9.1 s | 9.3 s | 9.4 s | 9.4 s |
| imports | 6.8 s | 4.7 s | 6.2 s | 4.8 s | 5.1 s | 5.1 s |
| express | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| next | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.1 s |
| prisma | 1.3 s | 1.1 s | 1.1 s | 1.2 s | 1.1 s | 1.1 s |
| infra | 0.0 s | 0.0 s | 0.0 s | 0.0 s | 1.3 s | 0.0 s |
| files | 0.0 s | 0.1 s | 0.1 s | 0.1 s | 0.4 s | 0.1 s |
| symbols | 0.1 s | 0.1 s | 0.1 s | 0.1 s | 0.2 s | 0.1 s |
| calls | 10.5 s | 12.5 s | 10.3 s | 12.2 s | 10.1 s | 10.5 s |
| http | 7.9 s | 7.7 s | 7.5 s | 7.9 s | 9.4 s | 7.9 s |
| sdk | 1.6 s | 1.5 s | 1.5 s | 1.5 s | 1.4 s | 1.5 s |
| queues | 2.3 s | 2.4 s | 2.3 s | 2.4 s | 2.2 s | 2.3 s |
| assemble | 0.5 s | 0.4 s | 0.4 s | 0.4 s | 0.5 s | 0.4 s |

Graph (run 1): 5,075 files, 19,422 nodes, 31,779 edges, 710 unresolved, 157 warnings, 25 MiB serialized.

Raw numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **The launch analyzer (0.3.0, M9.2d)** at `d17b3b7`, from the "Benchmark (1 vCPU)" workflow's run `42932700803` (UTC date 2026-11-11). Its twin run on another CPU model is `2026-11-11-cloudrun-caldiy-m9.2d-epyc9v74.md`.
- **42.3 s median analysis (41.1–43.8 s), within the 60 s budget.** M5.13a5 measured 33.7 s on this CPU model at 0.2.0 (`b7e5a59`, 32 MiB semi-space, now the default), so this is +26%, beyond the 13% seen between runners of one model. Most of it is in `imports` (1.9–2.0 → 4.7–6.8 s) and `http` (4.9–6.8 → 7.5–9.4 s); `programs` went from 8.6–8.9 to 9.1–9.7 s. `2026-11-10-analysis-calcom.md` has the comparison.
