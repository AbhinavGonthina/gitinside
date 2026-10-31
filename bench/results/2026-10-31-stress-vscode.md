# Stress benchmark: vscode (2026-10-31)

- **Repo:** https://github.com/microsoft/vscode at `11ba54a90a0ff8720cf47c086f5a9948eef9cf2c`
- **Analyzer:** 0.1.0 (gitinside `a8a01cdcdbb589ae12f6dcd814caa8575551519d`)
- **Method:** the repo's tarball downloaded like the worker does, extracted with the worker's extractor, then analyzed once in a fresh Node process per run, with production's limits lifted (size, entries, source files; heap 12,288 MB instead of 3,072 MB; no time limit). Parse only: nothing in the repo is installed or run.
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0

## Production limits

| Limit | Checked during | Production limit | Measured | Verdict |
|---|---|---:|---:|---|
| `LIMIT_SIZE` | extraction | 500 MiB | 328 MiB | within |
| `LIMIT_ENTRIES` | extraction | 100,000 | 25,233 | within |
| `LIMIT_FILES` | inventory | 20,000 source files | 15,184 source files | within |
| `LIMIT_MEMORY` | analysis | 3,072 MB heap | peak RSS 7,335 MiB, final heap 9,696 MiB | **over** |
| `LIMIT_TIME` | analysis | 5 min 0 s | 14 min 36 s | **over** |

**First limit hit in production:** `LIMIT_MEMORY` or `LIMIT_TIME`, during analysis, whichever the job reaches first (these numbers don't say which).

## Download and extraction

| Measure | Value |
|---|---:|
| Tarball (gzipped) | 64 MiB (67.1 MB) |
| Download time | 9,697 ms |
| Decompressed tar stream | 328 MiB (343.4 MB) |
| Entries (files + folders + skipped) | 25,233 |
| Files written | 20,722 |
| Folders | 4,510 |
| Skipped (links, special, unsupported names) | 1 |
| Extraction time | 68,990 ms |

## Inventory

| Measure | Value |
|---|---:|
| Files kept | 20,098 |
| Source files (`LIMIT_FILES` counts these) | 15,184 |
| Skip warnings | 72 |
| Time | 24,187 ms |

## Analysis

- Run 1: 875,895 ms (14 min 36 s), peak RSS 7,335 MiB, final heap 9,696 MiB

Per stage (run 1); "Ended at" is the time since `analyze` started:

| Stage | Took | Ended at |
|---|---:|---:|
| inventory | 21,100 ms | 21.1 s |
| workspace | 9 ms | 21.1 s |
| programs | 156,330 ms | 2 min 57 s |
| imports | 28,434 ms | 3 min 26 s |
| express | 432 ms | 3 min 26 s |
| next | 2 ms | 3 min 26 s |
| prisma | 9 ms | 3 min 26 s |
| infra | 95 ms | 3 min 26 s |
| files | 36,681 ms | 4 min 3 s |
| symbols | 1,674 ms | 4 min 5 s |
| calls | 221,333 ms | 7 min 46 s |
| http | 325,043 ms | 13 min 11 s |
| sdk | 61,015 ms | 14 min 12 s |
| queues | 2,316 ms | 14 min 14 s |
| assemble | 19,616 ms | 14 min 34 s |

At the 5 min 0 s limit the `calls` stage was running.

## Graph size

| Count | Value |
|---|---:|
| edges.calls | 250,703 |
| edges.external_call | 17 |
| edges.http | 128 |
| edges.imports | 154,078 |
| nodes.external | 6 |
| nodes.file | 15,184 |
| nodes.module | 2,644 |
| nodes.service | 1 |
| nodes.symbol | 131,566 |
| nodes.system | 1 |
| nodes.unresolved | 1,456 |
| warnings | 93 |

Raw numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **VS Code passes every check before parsing.** The gzipped tarball (64 MiB), the unpacked stream (328 MiB of 500), the entry count (25,233 of 100,000), and the source-file count (15,184 of 20,000) are all inside production's limits. So a production job would download, unpack, list files, and start parsing, then die on memory or time minutes in. That is the "runs for minutes, then fails" case #10 warns about; M5.16b makes it fail before parsing.
- **Memory is far over the cap.** V8's heap was 9,696 MiB when `analyze` returned, over 3× the worker's 3,072 MB `--max-old-space-size`, so a capped run fails with `LIMIT_MEMORY`. When it would pass 3 GB isn't measured here (only the end state is). cal.com (5,041 files) peaked near 2 GiB, mostly while building programs, so a guess is during `programs` or early in `calls`, but that's a guess. M5.16b measures it under the real cap.
- **Peak RSS reads lower than the heap (7,335 vs 9,696 MiB).** On Windows `maxRSS` is the peak working set, and on this 15.6 GiB laptop part of the heap was paged out, so RSS undercounts here. The final heap is the more reliable floor for the peak.
- **Time is about 3× the limit.** The run took 14 min 36 s. At 5 minutes it was in `calls`, with `programs` (2 min 36 s), `imports`, and `files` already done. This is one run on a 20-core laptop. The analysis is mostly single-threaded, and cal.com's runs here varied 2× from run to run. Cloud Run's 1 vCPU won't be faster.
- **Where the time goes:** `http` (5 min 25 s, 37%), `calls` (3 min 41 s), `programs` (2 min 36 s), `sdk` (1 min 1 s). `http` and `sdk` being this large is new: cal.com's report predates those stages. Together they spent 6.4 min finding 128 HTTP and 17 SDK edges among 250,703 calls, so that's where to look first (M5.16b notes what it would take).
- **Why it's this heavy: one service.** VS Code's root `package.json` declares no workspaces, so the analyzer falls back to a single package. That makes one service and one TypeScript program over all 15,184 files (the editor, about 100 built-in extensions, build scripts, tests). Per-service programs (M6.7's facts) wouldn't help unless the extensions became services. Graph: 131,566 symbols, 154,078 import and 250,703 call edges, about 25× cal.com's call edges. The graph's byte size wasn't recorded.
- **Unpacking cost.** Extraction took 69 s for 20,722 files on this Windows machine (small-file writes are slow here; see CLAUDE.md lessons). It will be much faster on Linux. On Cloud Run with `/tmp` in memory (M5.17c), the 328 MiB tree counts against the same 4 GiB as the heap.
- **Download:** 9.7 s for 67.1 MB from codeload.github.com, unauthenticated, at about 11 a.m. local time.
- **Graph not compared across runs:** one run only (`--runs 1`), so this report says nothing about determinism at this size. The fixture and eval determinism tests still cover that.
