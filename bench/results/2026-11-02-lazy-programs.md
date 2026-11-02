# Lazy programs: partial warm runs vs cold, before and after M6.7e3 (2026-11-02)

- **Question:** how much time does building a reused service's program only when a collected service needs it (M6.7e3, ADR-0177) save over M6.7e2, which reused clean services' facts but still built every program?
- **Builds compared:** `e2` = gitinside `08eff37` (M6.7e2), built in a scratch worktree; `e3` = `894fec4` plus M6.7e3's changes (uncommitted while measuring).
- **Folders:** `fixtures/shop-demo` (2 services, 13 source files), and this repo's own tree at `08eff37` (9 services; `node_modules`, `dist`, `.git`, and the eval/bench checkouts left out).
- **Method:** scratch scripts (not committed), one Node process per build and folder, in-memory cache, after 3 (shop-demo) or 1 (this repo) warm-up runs. For each edited file, each iteration: fill a fresh cache from the original tree, append `export const benchEdit = 1;` to the file, time a cold run (no cache), then a warm run with the cache (checked to give the cold bytes), restore the file. Medians over the iterations. A separate cold-only script times 5 plain runs of this repo's tree.
- **Machine:** dev machine (13th Gen Intel i7-13700H, 20 logical cores, 15.6 GiB RAM, Windows 11), Node v22.13.0, other programs open. Times are milliseconds.

## Raw output

shop-demo, 51 iterations, edits in this order (api, then web):

```json
{"label":"e2","fixture":"fixtures/shop-demo","n":51,"node":"v22.13.0","results":{"apps/api/src/server.ts":{"cold":41.808899999999994,"warm":44.66520000000037},"apps/web/lib/orders.ts":{"cold":44.60150000000067,"warm":46.30029999999897}}}
{"label":"e3","fixture":"fixtures/shop-demo","n":51,"node":"v22.13.0","results":{"apps/api/src/server.ts":{"cold":50.190599999999904,"warm":40.40989999999965},"apps/web/lib/orders.ts":{"cold":45.72199999999975,"warm":35.88900000000103}}}
```

shop-demo, 51 iterations, edits in the other order (web, then api):

```json
{"label":"e3","fixture":"fixtures/shop-demo","n":51,"node":"v22.13.0","results":{"apps/web/lib/orders.ts":{"cold":47.20720000000006,"warm":34.80249999999978},"apps/api/src/server.ts":{"cold":48.740499999999884,"warm":39.66059999999925}}}
{"label":"e2","fixture":"fixtures/shop-demo","n":51,"node":"v22.13.0","results":{"apps/web/lib/orders.ts":{"cold":53.1284999999998,"warm":55.07349999999951},"apps/api/src/server.ts":{"cold":50.58059999999932,"warm":54.01970000000074}}}
```

This repo's tree, 5 iterations:

```json
{"label":"e3-self","fixture":"apps/web/dist/e2","n":5,"node":"v22.13.0","results":{"apps/worker/src/run.ts":{"cold":3999.0023,"warm":2588.3822},"packages/diff/src/index.ts":{"cold":4717.137600000002,"warm":4075.467499999999}}}
{"label":"e2-self","fixture":"apps/web/dist/e2","n":5,"node":"v22.13.0","results":{"apps/worker/src/run.ts":{"cold":4312.171199999997,"warm":4141.340299999996},"packages/diff/src/index.ts":{"cold":4267.307399999991,"warm":4923.15830000001}}}
```

This repo's tree, cold only, 5 runs each (median total and per stage):

```json
{"label":"e3","folder":"apps/web/dist/e2","n":5,"cold":3667,"stageMs":{"inventory":280,"workspace":3,"programs":745,"imports":86,"express":3,"next":18,"prisma":101,"infra":9,"files":202,"symbols":6,"calls":568,"http":1030,"sdk":194,"queues":373,"assemble":19}}
{"label":"e2","folder":"apps/web/dist/e2","n":5,"cold":3643,"stageMs":{"inventory":281,"workspace":3,"programs":712,"imports":88,"express":3,"next":18,"prisma":94,"infra":9,"files":193,"symbols":6,"calls":659,"http":1021,"sdk":190,"queues":369,"assemble":19}}
```

An earlier 3-iteration run of each build on this repo's tree (superseded by the 5-iteration one above, kept because it was measured): e3 worker 4,968 cold / 2,608 warm, diff 4,358 / 4,802; e2 worker 3,719 / 3,281, diff 3,733 / 3,621.

## Observations (hand-written, not generated)

- **A partial run now saves time; before, it barely did.** With M6.7e2, a run that reused clean services' facts still built and walked every program for the repo-wide passes, so it took as long as a cold run or longer: shop-demo 44.7 and 46.3 ms warm vs 41.8 and 44.6 cold (and 55.1 / 54.0 vs 53.1 / 50.6 in the other order); this repo 4,141 ms warm vs 4,312 cold for the worker edit. With M6.7e3, shop-demo's partial runs take 34.8 to 40.4 ms against 45.7 to 50.2 cold, and the worker edit on this repo takes 2,588 ms against 3,999 cold, about 35% less.
- **The saving depends on what the edited service reaches.** The worker's file changes only the worker's entry, so only its program (and what it imports) is parsed. `packages/diff/src/index.ts` is imported by other services, so several services are dirty and their programs, plus the ones they reach, are parsed: 4,075 ms against 4,717 cold, where M6.7e2 took 4,923, more than its cold 4,267 (verifying the entries and hashing inputs cost more than the reuse saved).
- **Cold runs are unchanged.** The cold-only runs give 3,667 ms (e3) and 3,643 ms (e2) for this repo. The per-stage times are within noise of each other: `programs` 745 vs 712, `calls` 568 vs 659, `http` 1,030 vs 1,021. Lazy parsing only moves work in a cold run, because every program is collected. The `defaults` scan now walks each axios request's reachable files instead of every root file, and showed no cost here.
- **Noise is large next to these numbers.** Cold medians for the same build and folder differ by up to 0.7 s between processes on this repo (3,643 to 4,312 for e2), and by about 11 ms on shop-demo (41.8 to 53.1 for e2). The partial-vs-cold gap for the worker edit (1.4 s) is above that; the diff edit's (0.6 s) is at its edge. M6.8 measures a large monorepo properly.
- **Not measured:** a large monorepo (M6.8), memory, and Linux or Cloud Run.
