# Analysis benchmark: calcom (2026-10-26)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.1.0 (gitinside `ee2de97bbde208be568be2bbb0cde3ed2dc5c33b`)
- **Method:** 1 warm-up run, then 5 measured runs, each in a fresh Node process (EVALUATION.md §2).
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Graphs identical across runs:** yes

## Totals

| Measure | Median | Min | Max |
|---|---:|---:|---:|
| Wall-clock `analyze` | 53,341 ms | 27,069 ms | 77,055 ms |
| Peak RSS | 2051 MiB | 1890 MiB | 2148 MiB |

## Per stage

| Stage | Median | Min | Max |
|---|---:|---:|---:|
| inventory | 3,290 ms | 2,432 ms | 4,765 ms |
| workspace | 22 ms | 18 ms | 109 ms |
| programs | 32,686 ms | 11,803 ms | 33,420 ms |
| imports | 6,743 ms | 1,975 ms | 6,834 ms |
| express | 64 ms | 26 ms | 79 ms |
| next | 2,141 ms | 689 ms | 2,200 ms |
| prisma | 2,621 ms | 1,052 ms | 4,913 ms |
| files | 3,017 ms | 2,380 ms | 6,700 ms |
| symbols | 45 ms | 40 ms | 179 ms |
| calls | 5,573 ms | 3,737 ms | 18,606 ms |
| assemble | 283 ms | 259 ms | 913 ms |

## Graph size

| Count | Value |
|---|---:|
| edges.calls | 10,238 |
| edges.handles | 87 |
| edges.imports | 19,045 |
| edges.reads | 977 |
| edges.renders | 97 |
| edges.stores | 103 |
| edges.writes | 608 |
| nodes.datastore | 2 |
| nodes.file | 5,041 |
| nodes.model | 103 |
| nodes.module | 1,392 |
| nodes.page | 97 |
| nodes.route | 91 |
| nodes.service | 113 |
| nodes.symbol | 11,578 |
| nodes.system | 1 |
| nodes.unresolved | 589 |
| warnings | 139 |

Raw per-run numbers are in the JSON file next to this report.

## Observations (hand-written, not generated)

- **Spread is wide and bimodal:** runs 3–4 took 27–29 s, runs 1, 2 and 5 took 53–77 s, and the `programs` stage alone moved between 12 s and 33 s. Each run is a fresh process on the same checkout with identical output, so the difference is the machine (a Windows laptop with other work running, power/thermal state), not the analyzer. The median is reported as measured; treat it as a dev-machine number, not a budget check.
- **Where the time goes:** building the per-service `ts.Program`s (`programs`) is the largest stage in every run (12–33 s), followed by call resolution (4–19 s) and import resolution (2–7 s). That is the target for M6's incremental cache.
- **Budget (DESIGN.md §9):** "full analysis of a 5k-file repo ≤ 60 s" is defined on the Oracle VM, which doesn't exist until M5. This repo has 5,041 file nodes; the Oracle run is still owed.
- **Memory:** ~2 GiB peak RSS. The worker's per-job memory limit (M5.4/M5.10) has to allow for this.
