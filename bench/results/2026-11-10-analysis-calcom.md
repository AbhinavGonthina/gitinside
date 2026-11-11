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

## Observations (hand-written, not generated)

- **The launch analyzer (0.3.0, M9.2d), run at `ffc9a8f`.** The median was 110.7 s and the five runs spanned 106.5–112.6 s. Every run wrote the same graph.
- **This laptop's seconds don't compare across sessions.** The 2026-10-26 report (0.1.0) had a 53.3 s median, and M6.8c2's cold runs (2026-11-02) took 21.8–43.6 s. In this session's commit replay (`2026-11-10-incremental-calcom-commits.md`), though, one cold run took 33.6 s on the same code. Its neighbors took 101.7–104.5 s, and every stage of it was faster (`programs` 6.0 s against a 22.1 s median, `http` 7.7 s against 25.9 s). So for most of this session the laptop ran about 3× slower than it can, and the code alone doesn't explain the 110.7 s. As before, a laptop run can't judge the time budget.
- **The production-shaped number is the 1-vCPU run** (`2026-11-11-cloudrun-caldiy-m9.2d-epyc9v74.md` and `-epyc9v45.md`). It analyzed cal.diy at `2eb48ec` (5,075 files, the same size as this checkout's 5,073) in the worker image with production's limits. Medians were **49.4 s on AMD EPYC 9V74 and 42.3 s on EPYC 9V45**, both within DESIGN.md §9's 60 s.
- **Against M5.13a5 on the same CPU models** (0.2.0 at `6d90553`, its 32 MiB rows, now the default), the analysis got slower: 42.6 → 49.4 s (+16%) and 33.7 → 42.3 s (+26%). Two runners of one model have differed by up to 13% (M5.13a4a), so the 9V74 change is near that noise and the 9V45 one isn't. Comparing stage ranges with all of M5.13a5's runs on each model, the growth is mostly in `imports` (2.4–2.7 → 5.7–7.4 s on 9V74, 1.9–2.0 → 4.7–6.8 s on 9V45) and `http` (6.3–8.9 → 9.1–9.3 s, 4.9–6.8 → 7.5–9.4 s). `programs` barely moved (11.0–11.8 → 10.8–11.4 s, 8.6–8.9 → 9.1–9.7 s). The cause wasn't looked for here.
- **Graph:** 5,073 files, 114 services, 152 http and 152 external_call edges (the 0.1.0 report had neither kind), 710 unresolved, 157 warnings.
- **Memory:** peak RSS of 1,861–2,197 MiB (0.1.0: 1,890–2,148 MiB). On 1 vCPU the child peaked at 1,930–2,087 MiB, and the container at 2,187–2,370 MiB of its 4 GiB.
