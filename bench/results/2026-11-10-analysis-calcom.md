# Analysis benchmark: calcom (2026-11-10)

- **Repo:** https://github.com/calcom/cal.com at `0f19cc46ef6b6426ee398c670575b3c96be7af9e`
- **Analyzer:** 0.3.0 (gitinside `ffc9a8f98b23c9342bb4fb2daa2d631ec16d1872`)
- **Method:** 1 warm-up run, then 5 measured runs, each in a fresh Node process (EVALUATION.md §2).
- **Machine:** dev machine: 13th Gen Intel(R) Core(TM) i7-13700H (20 logical cores), 15.6 GiB RAM, win32 10.0.26300, Node v22.13.0
- **Graphs identical across runs:** yes

## Totals

| Measure | Median | Min | Max |
|---|---:|---:|---:|
| Wall-clock `analyze` | 110,666 ms | 106,466 ms | 112,595 ms |
| Peak RSS | 2009 MiB | 1861 MiB | 2197 MiB |

## Per stage

| Stage | Median | Min | Max |
|---|---:|---:|---:|
| inventory | 2,485 ms | 2,402 ms | 2,604 ms |
| workspace | 26 ms | 25 ms | 33 ms |
| programs | 24,012 ms | 22,589 ms | 25,273 ms |
| imports | 11,898 ms | 11,567 ms | 12,654 ms |
| express | 181 ms | 177 ms | 189 ms |
| next | 111 ms | 107 ms | 124 ms |
| prisma | 2,591 ms | 2,567 ms | 2,793 ms |
| infra | 84 ms | 49 ms | 435 ms |
| files | 177 ms | 117 ms | 826 ms |
| symbols | 214 ms | 190 ms | 241 ms |
| calls | 25,017 ms | 23,630 ms | 26,352 ms |
| http | 29,016 ms | 27,027 ms | 30,147 ms |
| sdk | 5,341 ms | 4,797 ms | 5,592 ms |
| queues | 8,093 ms | 7,638 ms | 8,745 ms |
| assemble | 1,021 ms | 946 ms | 1,130 ms |

## Graph size

| Count | Value |
|---|---:|
| edges.calls | 10,393 |
| edges.external_call | 152 |
| edges.handles | 89 |
| edges.http | 152 |
| edges.imports | 19,131 |
| edges.reads | 1,003 |
| edges.renders | 97 |
| edges.stores | 103 |
| edges.writes | 649 |
| nodes.datastore | 7 |
| nodes.external | 32 |
| nodes.file | 5,073 |
| nodes.model | 103 |
| nodes.module | 1,399 |
| nodes.page | 97 |
| nodes.route | 91 |
| nodes.service | 114 |
| nodes.symbol | 11,796 |
| nodes.system | 1 |
| nodes.unresolved | 710 |
| warnings | 157 |

Raw per-run numbers are in the JSON file next to this report.
