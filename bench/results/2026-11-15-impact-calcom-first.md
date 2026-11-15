# Impact analysis benchmark: calcom

- Date: 2026-11-15
- Repo: [calcom](https://github.com/calcom/cal.com) at `0f19cc46ef6b6426ee398c670575b3c96be7af9e` (19,422 nodes, 31,769 edges)
- GitInside: `ed6a2c7ce8d8d464c777e8f16c5e28701f78ff4c`, analyzer 0.3.10
- Machine: dev machine, 13th Gen Intel(R) Core(TM) i7-13700H (20 cores), 15.6 GiB, win32 10.0.26300, Node v22.13.0
- Method: `impactIndex` built 5 times; `impactOf` on 1,118 targets, 3 runs each (median kept), after one warm-up pass. Node runs the same V8 engine as Chromium, but a visitor's machine may be slower than this one.

## Summary

| | median | p95 | max |
|---|---|---|---|
| Index build | 109.93 ms | | 131.86 ms |
| One query | 0.01 ms | 13.93 ms | 101.99 ms |

Budget: a first question (index build + query) within 100 ms. Worst case measured: 211.92 ms (median build + slowest query), **over budget**.

## Slowest targets

| Target | Kind | Time | Dependents | May also reach |
|---|---|---|---|---|
| `service:features/` | service | 101.99 ms | 2,520 | 255 |
| `service:lib/` | service | 87.14 ms | 4,982 | 196 |
| `service:dailyvideo/` | service | 86.53 ms | 1,816 | 360 |
| `service:prisma/` | service | 64.51 ms | 5,008 | 526 |
| `service:fathom/` | service | 64.02 ms | 1,575 | 0 |
| `service:constants/` | service | 56.62 ms | 2,488 | 0 |
| `service:atoms/` | service | 44.72 ms | 2,720 | 0 |
| `service:app-store/` | service | 43.06 ms | 2,350 | 224 |
| `service:dayjs/` | service | 36.55 ms | 2,256 | 0 |
| `service:auth/` | service | 34.93 ms | 2,265 | 348 |

## By kind

| Kind | Targets | Median | Max | Most dependents |
|---|---|---|---|---|
| datastore | 6 | 0.01 ms | 17.49 ms | 2,224 |
| external | 32 | 0.02 ms | 0.82 ms | 76 |
| file | 203 | 0.02 ms | 24.42 ms | 2,122 |
| model | 103 | 0.90 ms | 6.77 ms | 418 |
| page | 97 | 0.00 ms | 0.00 ms | 0 |
| route | 91 | 0.48 ms | 2.51 ms | 21 |
| service | 114 | 8.49 ms | 101.99 ms | 5,008 |
| symbol | 472 | 0.00 ms | 0.71 ms | 276 |
