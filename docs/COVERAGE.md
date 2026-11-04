# Coverage: how apps call their backend, and what GitInside reads

Abhinav's decision on #18 (2026-11-04): stop fixing the analyzer one eval batch at a time. Instead, list the common ways React/Next apps call their backend and the ways Express/Next receive those calls, rank them by how much they're really used, and cover each one as a general, documented pattern, never a repo special case. This file is that list (M5C.1). Each gap below becomes its own task (M5C.2, M5C.3a–f in PROGRESS.md), most used first. Fastify, NestJS, Hono and the rest stay in the later expansion (#13).

## How usage was measured

Three measures, all taken on 2026-11-04. The raw numbers, queries, and per-repo counts are in [`usage/2026-11-04.json`](usage/2026-11-04.json).

1. **GitHub code search:** files matching a query in public repos.
   - Source: `GET /search/code` (GitHub's REST code search), `total_count` with `per_page=1`. Each query was run once per language (`TypeScript`, `TSX`, `JavaScript`) and the three counts summed, except the `filename:` queries.
   - **This is the ranking measure,** because it counts use in app code rather than installs.
2. **npm downloads:** for the last month (2026-10-05 to 2026-11-03), from `api.npmjs.org/downloads/point/last-month/<package>`. Shown as a cross-check only.
3. **The eval set:** how many of the 12 pinned eval repos (`eval/repos.json`) use the pattern. Measured by regexes over each repo's source files at its pinned SHA.

**Limits of these numbers.** Read them as orders of magnitude, not exact counts.
- **Code search totals are GitHub's estimates.** Repeating a query gave the same total (`"axios.create"`: 563,200 / 31,904 / 700,416 both times), but that only shows the estimates are stable, not that they're exact.
  - The search indexes default branches and skips most forks.
  - It matches words, so a query also counts comments, docs inside code files, and vendored copies.
- **Rows count different things.** For example, `QueryClientProvider` appears about once per app (its setup file), while `await fetch` appears once per file that makes a request. So only compare rows when they differ by an order of magnitude or more. Within the same order of magnitude, the order follows the measured count but means little.
- **Some queries didn't work and were dropped.** Quoted import phrases (`"from axios"`, `"from swr"`) matched almost nothing: 5,184 TypeScript files for axios, against 563,200 for `"axios.create"`. The engine seems to keep the quote characters on `'axios'`. Those libraries were measured again by identifier (`useSWR`, `ofetch`) or by `"import X"`. The unqualified `"export async function GET"` gave 6,185,525 TypeScript files but 108 TSX files, so App Router handlers are counted with `filename:route.ts` / `filename:route.js` instead. Both runs are in the raw file.
- **npm downloads mix in installs that aren't app code:**
  - packages pulled in by other packages (`node-fetch`, `undici`, `cross-fetch`, and `ofetch` through Nuxt/unjs tooling),
  - CI installs,
  - and for `@reduxjs/toolkit`, every Redux user, not only RTK Query users.
- **The eval set is 12 small to mid-size hobby and reference apps** (EVALUATION.md §1). It shows what real repos of these stacks contain, not how common anything is.

**Status** says what the analyzer does today:
- **handled:** the pattern's documented forms become requests or routes.
- **partial:** some forms are read; the rest are listed in the detector's "Patterns not handled".
- **not handled:** no request comes from it. A request through an unhandled client is missing from the diagram, unless a wrapper or hook around it is read. Where the analyzer sees the call but can't follow it, it shows an unresolved node with a reason instead of a guess.

## Calling side: how frontends send requests

Ranked by code search count.

| # | Pattern | Code search (files) | npm, last month | Eval repos (of 12) | Status | Where it's decided |
|---|---|---|---|---|---|---|
| 1 | `fetch` (global, `window.`/`globalThis.`, or from `node-fetch`, `cross-fetch`, `isomorphic-fetch`, `isomorphic-unfetch`, `unfetch`, `undici`) | 23,592,960 (`"await fetch"`; misses `.then` chains) | `undici` 919,890,436; `node-fetch` 835,744,455; `cross-fetch` 153,252,667 (mostly installed by other packages) | 6 | handled | ADR-0030, ADR-0031; `http.ts` |
| 2 | axios default export: `axios(config)`, `axios.get(url)`, … | 9,742,404 (`"import axios"`) | `axios` 449,708,740 | 8 | handled | ADR-0030, ADR-0160 |
| 3 | axios instances: `axios.create({ baseURL })`, `x.defaults.baseURL = …` | 1,295,520 (`"axios.create"`) | (in `axios`) | 4 | partial: an instance that's destructured, kept in a collection, or assigned later without a type, and `Object.assign(x.defaults, …)`, aren't followed | ADR-0030, ADR-0161; `http.ts` "not handled" |
| 4 | Next.js server actions (`"use server"` functions called from client components) | 1,286,781 (`"use server"`) | (in `next`) | 0 | handled as a `calls` edge (no route: Next gives an action no URL of its own). A form's `action`/`formAction` and `useActionState`'s action count as calls, and the browser's calls (those, or a call in a `"use client"` file) are labeled `server action`. Not handled: actions defined inside a component, calls from client-only modules without `"use client"`, actions passed through props. Not labeled in the eval (not an HTTP request in the repo's code). The viewer doesn't show the label yet (M5C.3a2) | ADR-0203; `calls.ts` |
| 5 | TanStack Query (`useQuery({ queryKey, queryFn })`, `useMutation({ mutationFn })`) | 1,048,448 (`QueryClientProvider`, about one per app) | `@tanstack/react-query` 254,287,015; `react-query` (v3) 6,533,385 | 3 | partial: a `queryFn` or `mutationFn` is read like any function, so the `fetch`, axios, or wrapper call inside it resolves. A URL read from the key in its context isn't (row 12) | ADR-0196 |
| 6 | axios interceptors (`x.interceptors.request.use(…)`) | 653,536 (`"interceptors.request.use"`) | (in `axios`) | 2 | not read. That's correct when they only set headers or retry on 401, as both eval repos' do (foodie retries a 401; nextjs-prisma-boilerplate's are commented out). An interceptor that rewrites `config.url` or `baseURL` isn't followed. No task: a code search can't count the URL-rewriting kind, and the eval set has none | `http.ts` "not handled" |
| 7 | ofetch (`ofetch(url, { method, baseURL })`, `ofetch.create`) | 348,608 (identifier `ofetch`; also counts Vue/Nuxt projects, outside v1's React frontends) | `ofetch` 88,754,211 (mostly through Nuxt/unjs) | 0 | not handled | `http.ts` "not handled"; M5C.3c |
| 8 | SWR (`useSWR(key, fetcher)`, `SWRConfig`'s `fetcher`) | 291,869 (`useSWR`) | `swr` 78,623,930 | 1 | handled: the fetcher is inlined at the hook with each key. Not handled: method fetchers, nested named fetchers, and array keys (which stay `DYNAMIC_URL`) | ADR-0193, ADR-0194; `wrappers.ts` |
| 9 | RTK Query with `fetchBaseQuery({ baseUrl })` | 96,720 (`fetchBaseQuery`) | `@reduxjs/toolkit` 138,320,163 (all Redux users) | 1 | handled | ADR-0196 |
| 10 | ky (`ky.get(url)`, `ky.create({ prefixUrl })`, `ky.extend`) | 35,520 (`"import ky"`) | `ky` 28,733,005 | 0 | not handled | `http.ts` "not handled"; M5C.3e |
| 11 | RTK Query with a custom base query (a re-auth wrapper around `fetchBaseQuery`, typed `BaseQueryFn`) | 9,195 (`BaseQueryFn`) | (in `@reduxjs/toolkit`) | 1 (Recipen, all 25 of its call sites) | handled since M5C.2 when the wrapper passes its arguments on unchanged to one `fetchBaseQuery` (RTK's re-auth example), and its own calls of the `fetchBaseQuery` result are requests. A wrapper that rewrites, hands on, or splits its arguments stays an unresolved node per endpoint (M5B.7b) | ADR-0196, ADR-0201 |
| 12 | TanStack Query key in context: `queryFn: ({ queryKey }) => fetch(queryKey[0])`, a `QueryClient`'s default `queryFn` | 3,850 (`"queryFn: ({ queryKey"`) | (in row 5) | 0 | not handled: stays `DYNAMIC_URL` | ADR-0196; M5C.3f |
| — | Repo-defined wrappers (`api.get(path)` over `fetch` or axios) | can't be counted with a code search (any name, any shape) | — | at least 3 (WealthWise's path-taking `fetch` wrapper, foodie's wrapper over `axios(config)`, twitter-clone's SWR fetcher; EVALUATION.md §1) | partial: inlined one level deep, including `const` object methods and whole-config parameters. A wrapper calling a wrapper is `WRAPPER_DEPTH`, and destructured parameters aren't bound | ADR-0032, ADR-0159, ADR-0160, ADR-0164; `wrappers.ts` "not handled" |

Clients mostly used by servers to call other services (`got` 163,331,838 and `superagent` 96,172,686 downloads; `XMLHttpRequest`, `EventSource`) are left out of the ranking. A frontend rarely calls its own backend through them, and they stay listed under `http.ts` "not handled". Socket.io and WebSocket clients aren't HTTP requests (EVALUATION.md §1 doesn't label them).

## Receiving side: how backends take requests

| # | Pattern | Code search (files) | npm, last month | Eval repos (of 12) | Status | Where it's decided |
|---|---|---|---|---|---|---|
| 1 | Express apps, routers, and middleware (`express()`, `Router()`, `x.get(path, h)`, `x.route(path)`, `x.use(prefix, router)`) | 5,070,404 (`"express.Router"`); 3,360,184 (`"import express"`) | `express` 590,925,414 | 10 | handled: mounts composed across files, routers passed to functions, routers loaded from a folder listing. Partial: routers imported from other workspace packages or kept in collections, and dynamic paths (shown as `DYNAMIC_ROUTE`) | ADR-0026, ADR-0093, ADR-0162; `express.ts` |
| 2 | Next.js App Router route handlers (`app/**/route.ts` exporting `GET`, `POST`, …) | 3,557,376 (`"export async function GET"` in `filename:route.ts` 3,301,376 + `filename:route.js` 256,000) | `next` 275,607,626 (all of Next) | 2 | handled | ADR-0027; `next.ts` |
| 3 | Dev proxies between a SPA and its API: Vite `server.proxy` (with or without `rewrite`), CRA's `"proxy"` | 549,376 (`proxy` in `filename:vite.config.ts` 308,224 + `.js` 241,152; any mention) | — | 1 (foodie's CRA `"proxy"`, which can't rewrite paths) | not read: a root-relative request is matched to routes in other services at `heuristic`, assuming the proxy keeps the path. A `rewrite` that strips a prefix (`/api/users` reaching `/users`) isn't applied, and the proxy's target isn't used to pick the service | `match.ts` "not handled"; M5C.3b |
| 4 | Next.js pages router API routes (`pages/api/**`, `req.method` guards) | 360,132 (`NextApiRequest`, TypeScript only; 145,920 of them under `path:pages/api`) | (in `next`) | 3 | handled, including negated method guards | ADR-0027, ADR-0195; `next.ts` |
| 5 | `next.config` `rewrites` and `basePath` | 86,656 (`rewrites` in `filename:next.config.js` 25,600 + `.mjs` 22,272 + `.ts` 38,784) | (in `next`) | 0 | not read: a rewritten path or a `basePath` prefix isn't applied when matching | `next.ts` and `match.ts` "not handled"; M5C.3d |
| 6 | next-connect routers in `pages/api` | 19,218 (`"next-connect"`) | `next-connect` 583,148 | 1 | handled | ADR-0191; `next.ts` |

## The gaps, in the order they're planned

C1 comes first, as Abhinav asked on #18. After it, the gaps follow the code search count of the form that isn't handled:

1. **M5C.2: RTK Query custom base queries** (row 11; 9,195 files; Recipen's 25 call sites). Done: ADR-0201.
2. **M5C.3a: Next.js server actions** (row 4; 1,286,781 files). Done: ADR-0203 keeps them as `calls` edges, adds form and `useActionState` references, and labels the browser's calls `server action`; EVALUATION.md doesn't label them. The viewer shows it as "calls · server action" (M5C.3a2).
3. **M5C.3b: Vite and CRA dev proxies** (receiving row 3; 549,376 config files mention `proxy`).
4. **M5C.3c: ofetch** (row 7; 348,608).
5. **M5C.3d: `next.config` `rewrites` and `basePath`** (receiving row 5; 86,656).
6. **M5C.3e: ky** (row 10; 35,520).
7. **M5C.3f: TanStack Query key in context** (row 12; 3,850).

**Not planned as tasks:**
- **The partial edges of handled patterns:** destructured axios instances, wrappers nested more than one level, routers in other workspace packages. None of them can be counted with a code search, and the eval set no longer misses any of them. A fresh sample (M5C.5) that misses one will show it.
- **URL-rewriting axios interceptors** (row 6): there's no usage count for that kind, and none in the eval set.
