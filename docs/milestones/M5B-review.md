# M5B review: Batch 2's misses + a fresh blind batch 3

**Tag:** `m5b`, after the review fixes M5B.7b–e and the re-check M5B.7f (2026-11-04) · **Range:** `c6540a3..797d3f4`, M5B commits only (M5B.1–M5B.6; M5.17e6's worker migrations, `19af335`, are interleaved and belong to M5); fixes `54a7de5`, `53293dd`, `b4b42f3`, `97e135b`, `d123148` · **Date:** 2026-11-03

## What was built

M5A's blind batch 2 scored 45.8% precision and 35.5% recall, from two library patterns the analyzer didn't know: `next-connect` routers and SWR hooks. M5B (Abhinav, #15) fixed those from each library's documented contract, not from the batch 2 repos, marked batch 2 seen, and measured generalization again on a fresh blind batch 3.

| Piece | Where | What it does |
|---|---|---|
| next-connect routers | `next.ts` (ADR-0191) | A `pages/api` default export that is a next-connect router (v0 `nc()`, v1 `createRouter()` + `router.handler()`, repo factories) gives one route per registered method; `.all` is `ALL`; a pattern argument or the router passed on keeps `ALL` with `NEXT_CONNECT_UNSEEN_METHODS` |
| SWR fetchers | `wrappers.ts` (ADR-0193) | `useSWR`, `useSWRImmutable`, `useSWRInfinite`, `useSWRMutation`, `preload` call the repo's fetcher at the hook with the key as its first argument; falsy keys make no request, function keys give what they return, array keys are `DYNAMIC_URL`; `SWRConfig`'s fetcher is the default when it's the service's only one (`heuristic`) |
| Inline SWR fetchers | `wrappers.ts`, `http.ts` (ADR-0194) | `useSWR(key, (url) => fetch(url))`, `fetcher` in a config or `SWRConfig`'s `value`, and the docs' `(...args) => fetch(...args)` (a spread of the rest parameter reads the caller's arguments) |
| Negated method tests | `next.ts` (ADR-0195) | The polarity of `req.method !== "A" && …`, `!(… === …)`, `![…].includes(req.method)` read through `!`, `&&`, `||`; a block that serves (calls besides `res`/`console`, no 405/`Allow`) makes the handler `ALL` |
| RTK Query endpoints | `http.ts` (ADR-0196) | `build.query`/`mutation`/`infiniteQuery` under `createApi`/`injectEndpoints` with RTK's `fetchBaseQuery` (directly, via a `const`, or in `retry`) are requests at their definition, one per value `query` returns, `baseUrl` joined like axios's `baseURL`; TanStack Query needs no contract (pinned by a test) |
| Batch 2 seen, batch 3 | `eval/repos.json`, `eval/src/report.ts` | Batch 2 marked seen with why; the report says when no unseen batch is left; batch 3 (`Avinash905/Recipen`, `nidhish-nayak/trendz`) labeled and committed before its one blind run |

Four new fixtures with goldens: `next-connect`, `swr-fetchers`, `next-method-exclusions`, `rtk-query`. `KEY_FORMAT` (the incremental cache's key version) went 5 → 10, one step per change in what a service's facts contain.

## Results (exactly as measured)

- **Tests (local at `797d3f4`, uncached):** 3,819 passed, 4 skipped: analyzer 1,056, viewer 1,079, web 623, worker 622 (+1 skipped), db 141 (+3 skipped), diff 122, eval 89, bench 54, schema 33. The full parallel run (`npx turbo run test --force`) failed one viewer test, `diffMode.test.tsx` "flies to a row's node, opening its ancestors, selecting and focusing it" (focus on `<body>`), the focus flake already seen under load in M5B.2b; turbo then stopped before analyzer, web, worker, and bench finished. Viewer alone: 1,079/1,079. The other four, uncached: all green (analyzer, bench, worker through turbo with 0 cached; web alone). CI on `797d3f4` (run 41758490457): green on all five jobs.
- **Analyzer coverage (CI, `797d3f4`; local `coverage` times out one analyzer test on this machine):** 97.62% lines, 91.12% branches (target 85%; 97.62% / 90.96% at m5a). The files M5B touched: `next.ts` 97.29% / 89.92%, `http.ts` 97.9% / 90.48%, `wrappers.ts` 95.96% / 90.7%. Diff 99.01% / 93.61%.
- **Accuracy** ([report](../../eval/results/2026-11-03-0.1.0.md), reproduced byte for byte by `pnpm eval --check` at `797d3f4`; pending owner review #1):

  | Set | Before M5B | After M5B |
  |---|---|---|
  | Original five | 100.0% (138/138), 100.0% (138/138) | unchanged |
  | Held-out batch 1 (seen) | 100.0% (78/78), 100.0% (78/78) | unchanged |
  | Held-out batch 2 (now *seen*) | 45.8% (11/24), 35.5% (11/31), blind | **100.0% (31/31), 100.0% (31/31)**, all `exact`; recall 77.4% after M5B.1, 96.8% after M5B.2, 100.0% after M5B.2c |
  | Held-out batch 3 (*unseen*, scored once) | n/a | **100.0% (45/45), 64.3% (45/70)** ([blind run at `08caa77`](https://github.com/AbhinavGonthina/gitinside/blob/08caa77/eval/results/2026-11-03-0.1.0.md#held-out-batch-3-unseen)) |

  Batch 3 is the generalization result, and it's below the 80% recall target: trendz 45/45 (TanStack Query over an axios instance, all `heuristic`), Recipen 0/25. Every Recipen miss has one cause (C1 in the [diagnosis](../../eval/results/2026-11-batch3-diagnosis.md)): its RTK API's `baseQuery` is RTK's documented re-auth wrapper around a `fetchBaseQuery` result, which ADR-0196 doesn't follow. Abhinav's answer on #18 (2026-11-04): no more batch-by-batch loops. M5C covers the common calling and receiving patterns from a ranked list instead (C1 first, M5C.2), then scores one fresh blind sample.

## Key decisions and trade-offs

- **Contracts from the library, never from the eval repo.** Each fix started from the library's docs and source (RTK's `fetchBaseQuery.ts` and `joinUrls.ts` for the `baseUrl` join; SWR's documented fetcher signatures), and each fixture was written from that general form, not copied from batch 2.
- **A library that calls repo code is modeled as a call at the hook.** SWR's `useSWR(key, fetcher)` becomes "the fetcher, called here with `key`", so the existing one-level wrapper inlining does the rest. RTK's `fetchBaseQuery` has no repo call at all, so its configuration *is* the call site.
- **Prefer an extra route to a missing one.** A negated guard whose block only *looks* like it serves gets an `ALL` route (ADR-0195), and a next-connect router passed to unknown code keeps `ALL` with a warning. The review found the cost of that rule (findings 3–5).
- **Seen vs unseen again** (ADR-0168): batch 2's 100% is quoted as seen; batch 3 was labeled, committed, and scored once, and its 64.3% goes in the README as measured.

## Hardest problem: SWR, where the library calls the repo's fetcher

`useSWR("/api/books", fetcher)` contains no request: SWR calls `fetcher("/api/books")` later, inside `node_modules`, which the analyzer never reads. Before M5B the only request was inside `fetcher` itself, `fetch(url)` on a parameter, so it was a wrapper with nothing calling it and stayed `DYNAMIC_URL`. ADR-0193 reads SWR's contract instead: each hook (found by its import from `swr`, not by name) is a call to its fetcher with the key bound to the first parameter, so the M2 wrapper machinery inlines it at the hook. The key needed its own reading: `null`, `false`, and the falsy side of `cond ? url : null` mean "no request", a function key gives what it returns, and an array key is `DYNAMIC_URL` because SWR 1 and 2 pass it differently. Two traps came after. Inline fetchers have no symbol ID, and the cached wrapper index is keyed by symbol IDs, so ADR-0194 keys them by their syntax node inside a service instead, without touching the cache's shape. A function that only *looks* like a fetcher (any call's second argument, `addEventListener` too) falls back to its own request when no hook calls it, so no call site can be dropped.

## What's still weak

- **Generalization is still below target:** 64.3% blind recall on batch 3, all from one unread wrapper (C1). Since M5B.7b the missed endpoints at least show as unresolved with a reason; following the wrapper is M5C.2.
- **Small sample:** 12 hobby-size repos, 330 labels; labels unreviewed (#1).
- **The `ALL` fallbacks are coarse:** an `ALL` route can match a client's wrong-method call, which hides a broken connection from the PR bot (finding 5). M5B.7d narrowed it the other way: a negated block answering with a synchronous call (`res.json(getSettings())`) or doing its only work in a statement call named like a log level (`audit.log(entry)`) now reads as a refusal, so its `ALL` route is missing and a client's call to it shows as unresolved (re-check findings R2–R3; ADR-0195 names the cost).
- **Generated RTK hooks aren't followed:** requests are drawn from the API slice, not from the components calling `use…Query`.
- **URL builders aren't evaluated:** in the smoke test, `useSWR(id ? restEndpoints.tool(id) : null, fetcher)` stays `DYNAMIC_URL` because `tool: (id) => \`/api/tool/${id}\`` is a function returning a URL, not a request. That's visible with its reason, but a link a reader would expect.

## Fresh-eyes review

A subagent with no prior context reviewed M5B's commits (analyzer, viewer, eval, fixtures, README/EVALUATION.md) against SPEC.md, DESIGN.md, TESTING.md, SECURITY.md, EVALUATION.md, and ADR-0191–0196, read-only. It found nothing high-severity and **no repo-specific cases**: no eval repo names or identifiers in analyzer source; fixtures follow each library's documented form. It confirmed determinism (no `Date.now`, randomness, or `localeCompare` added; sorting through `compareStrings`), nothing executed or read outside the repo, bounded recursion (`MAX_ROUTER_HOPS`, `MAX_HOPS`, ≈2⁸ keys per hook), `KEY_FORMAT` bumped in each code commit, batch 3's labels committed before its blind run, and README/EVALUATION.md numbers matching the report. Findings 1, 3, and 4 were confirmed by reading the code; the rest are plausible until each fix's regression test fails first.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium | RTK endpoints under a custom `baseQuery` give no request and no unresolved node (`http.ts` `rtkEndpoint` returns `[]`), so a call site vanishes; "fail visibly" broken. Batch 3's 25 misses are this. | Fixed in M5B.7b (`54a7de5`): one unresolved `DYNAMIC_URL` site per endpoint, its detail saying the base query isn't followed; Recipen's missing sites 25 → 1, scores unchanged. Following the wrapper is M5C.2 (#18) |
| 2 | Low–medium | A next-connect router declared in a shared file and exported: only its own file is walked (`connectRouter`), so `pages/api/a.ts`'s `r.get` and `b.ts`'s `r.post` on one v0 instance give GET-only and POST-only, no warning. Same for `.use(subRouter)`. | Fixed in M5B.7c (`53293dd`): a module-level router from another file, an exported one, and `.use(x)` with a next-connect router each keep `ALL` with `NEXT_CONNECT_UNSEEN_METHODS`; scores unchanged |
| 3 | Low | `.all(h)` plus any unseen reason adds `ALL` twice (`next.ts` `connectRoutes`), so `NEXT_DUPLICATE_ROUTE` says the file duplicates itself. | Fixed in M5B.7c (`53293dd`), confirmed red by a mutation check |
| 4 | Low | `export { handler as default }` is read as the router escaping (`use` exempts only `ExportAssignment`): a spurious warning and `ALL` route. | Fixed in M5B.7c (`53293dd`), red first |
| 5 | Low | A negated guard's refusal with any other call (`log.warn(…)`, `res.json({ error: t("…") })`) reads as serving, adding `ALL`. | Fixed in M5B.7d (`b4b42f3`): a log-level method called as a statement and synchronous calls in an answer's arguments aren't work (an awaited one is); ADR-0195 amended, scores unchanged |
| 6 | Low (docs) | A destructured RTK builder (`({ query }) => …`) isn't read and isn't in `http.ts`'s "not handled" list; a router with only unseen registrations drops its `NEXT_CONNECT_UNSEEN_METHODS` warnings. | RTK part fixed in M5B.7b: a builder destructured in the `endpoints` parameter is read; `const { query } = build` listed as not handled. Warnings fixed in M5B.7c (`53293dd`): a router with only unseen registrations keeps them |

## Re-check after the fixes (M5B.7f, 2026-11-04)

- **Tests (local at `667571f`, `npx turbo run test --force`, 0 of 15 cached):** 3,919 passed, 4 skipped, nothing failed: analyzer 1,071, viewer 1,090, web 650, worker 627 (+1 skipped), db 142 (+3 skipped), diff 122, bench 95, eval 89, schema 33. After the `KEY_FORMAT` bump (`d123148`): analyzer 1,071/1,071, root typecheck and lint clean.
- **Coverage (CI run 41821296763 on `cd52687`):** analyzer 97.67% lines, 91.11% branches (target 85%); `next.ts` 97.51% / 90.5%, `http.ts` 98.19% / 90.61%, `wrappers.ts` 95.96% / 90.7%, `prisma.ts` 95.65% / 86.51%, `incremental.ts` 100% / 89.77%. Diff 99.01% / 93.61%. Every other package ≥ 94.62% lines (target 70%).
- **Accuracy:** no delta from any fix. The report at `d123148` ([2026-11-04-0.2.0](../../eval/results/2026-11-04-0.2.0.md)) has the same counts as at `797d3f4`, and `pnpm eval --check` reproduced it byte for byte. Batch 3's blind result stays quoted as measured: 100.0% (45/45) precision, 64.3% (45/70) recall.
- **CI:** all five jobs green on `cd52687` after one rerun. The `visual` job failed `Explorer / Diff, change picked` on `0b0c70f` (dark, 951 px) and on `cd52687` (light, 947 px), the ~950 px flake first seen in M5B.1; a rerun passed it, and the deploy then shipped. M5B.9 makes it stable.

A second fresh-eyes review (a subagent with no prior context, read-only) went through the four fix commits. It found no repo-specific cases (no eval repo names in `packages/`), no nondeterminism, the "not handled" lists updated in each detector, and regression tests for every finding.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| R1 | Medium | `97e135b` changed what a service's cached Prisma facts hold but left `KEY_FORMAT` at 13 (`ANALYZER_VERSION` is still 0.2.0), so a worker's `/tmp` cache from before it would reuse old facts for an unchanged service: `prisma().tool.findMany()` again with no edge and no unresolved node, and warm ≠ cold | Fixed in `d123148` (`KEY_FORMAT` 14), deployed with run 41821296763. No eval delta |
| R2 | Medium (accepted) | Since M5B.7d, a negated block answering with a synchronous call (`return res.status(200).json(getSettings())`) reads as a refusal, so its `ALL` route is missing | Accepted: the cost is named in ADR-0195's amendment, and a client's call to such a route shows as unresolved (`NO_MATCHING_ROUTE`), not as a wrong edge. Listed under weaknesses |
| R3 | Low (accepted) | A statement call named like a log level (`await audit.log(entry)`) as a negated block's only work reads as a log line, with the same effect as R2 | Accepted, as R2 |
| R4 | Low | `export const router = nc(); export { router as handler };` adds the "is exported" reason twice, so `NEXT_CONNECT_UNSEEN_METHODS` is warned twice for one file | Follow-up M5B.8 |
| R5 | Low (known) | The re-auth wrapper's own refresh call (`rawBaseQuery("session/refresh", …)`) is neither an edge nor an unresolved node | Documented under `http.ts`'s "not handled"; M5C.2 follows the wrapper and its refresh call |
| R6 | Low (accepted) | The callee-name rule draws a `heuristic` edge for `createPrismaMock().user.findMany()` | Accepted: edges from it are marked `heuristic`, and a negative case (`cache()`) is tested |

## Smoke test

Built CLI on a real public repo outside the eval, as a user would run it: `MileTwo/nextjs-ts-prisma-rest` at `fbb30ee` (Next.js pages router, SWR, Prisma, one package), `node packages/analyzer/dist/cli.js analyze <checkout> --owner MileTwo --name nextjs-ts-prisma-rest --sha fbb30ee… --out …`.

- Exit 0, a 58.7 KB graph: 1 service, 14 modules, 30 files, 30 symbols, 2 pages, 3 routes (`GET /api/tool`, `POST /api/tool`, `GET /api/tool/:id`, from `switch (method)` with a 405 `default`), 1 model, 1 datastore; edges: 34 imports, 5 calls, 3 handles, 3 `http`, 2 renders, 1 stores, 1 writes. No warnings.
- **Requests, checked by hand against the code:** `pages/index.tsx`'s `useSWR(restEndpoints.tools, fetcher)` → `GET /api/tool`, `exact` (M5B.2: before M5B this was `DYNAMIC_URL` inside `fetcher`); `ToolDialog.tsx`'s `fetch(restEndpoints.tools, { method: "POST" })` → `POST /api/tool`, `exact`; `pages/tool/[id].tsx`'s `useSWR(query?.id ? restEndpoints.tool(query.id) : null, fetcher)` → unresolved `DYNAMIC_URL` (a URL builder's return, see weaknesses). No wrong edge.
- Two unresolved nodes, both with reasons: that `DYNAMIC_URL` and an `UNKNOWN_SYMBOL` for `types/global.d.ts`'s `import("./services/prisma")`, a path that really doesn't exist from `types/`.
- **A silent gap, not from M5B:** the API handlers' Prisma calls (`prisma().tool.findMany()`, `findUnique`, `create`) draw no edge and no unresolved node; only `prisma/seed.ts`'s `new PrismaClient()` write appears. `services/prisma.ts` is a factory typed `(): PrismaClient` that returns `global.prisma || new PrismaClient()` through `// @ts-ignore`, which `prisma.ts` documents as handled ("factory functions"). Fixed in M5B.7e (`97e135b`): a factory's declared client return type counts on its own, so all five `prisma()` calls now draw `exact` edges (6 Prisma edges, was 1), and a call receiver is read by its callee's name for the heuristic (`ctx.prisma().user`).
- A second run wrote a byte-identical file.

## Interview questions

**1. Batch 2 went from 35.5% to 100% recall. What does that number prove?**
Only that the M5B fixes work on batch 2, because they were chosen with its misses in view; that's why it's now marked seen (ADR-0168). The generalization claim rests on batch 3, labeled and committed before the analyzer ever ran on it and scored once: 64.3% recall, 100% precision. *Follow-up:* "Why not fix C1 and re-score batch 3?" Then batch 3 is seen too and the next honest number needs a batch 4; that's the choice put to Abhinav in #18.

**2. How do you find a request that a library makes for you?**
Read the library's contract and turn its configuration into a call site. SWR calls the repo's fetcher with the key, so each hook becomes a call to that fetcher, which wrapper inlining already handles. RTK's `fetchBaseQuery` does the `fetch` inside `node_modules`, so each `build.query` endpoint *is* the request, with its URL from what `query` returns and `baseUrl` joined the way RTK's `joinUrls` does. *Follow-up:* "And when the repo wraps the library?" That's batch 3's miss: a custom base query around `fetchBaseQuery` isn't followed, and the review found it isn't even shown as unresolved.

**3. `if (req.method !== "POST") { … }`: which routes does that file have?**
It depends on the polarity and on what the block does. Each `!` flips the test, through `&&`, `||`, and parentheses; here the block runs for every method but POST. If the block only answers (a 400, a 405, `Allow`, a `throw`), it's a guard and the file serves POST. If it does real work, it serves every other method, so the file gets `ALL`, and POST only if code after the `if` or an `else` can serve it. *Follow-up:* "What breaks that?" A refusal that also logs: any call outside `res`/`console` counts as work (finding 5).

**4. Why bump `KEY_FORMAT` when the facts' JSON shape didn't change?**
Because their meaning changed: a service analyzed before M5B.2 has no SWR requests in its facts, and the incremental cache would reuse those facts for an unchanged service, giving a graph that a cold run wouldn't. The key version is part of every cache key, so a bump turns every old entry into a miss. *Follow-up:* "How do you know warm equals cold?" The incremental tests compare warm and cold bytes over fixture edits, and the cache JSON round-trip test runs on every fixture, including the four new ones.

**5. Recipen scores 0/25 with 100% precision. Is that a good failure?**
Better than wrong links, but not good: no false edge is drawn, but the 25 calls aren't on the diagram at all, not even as unresolved, so nothing tells the reader something is missing. "Fail visibly" says an edge the analyzer can't resolve is shown with a reason. M5B.7b makes each endpoint under an unreadable base query an unresolved node, whatever #18 decides about following the wrapper.

Quiz yourself: open Claude Code and say 'quiz me on M5B'.
