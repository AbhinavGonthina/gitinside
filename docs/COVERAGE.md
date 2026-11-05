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
| 4 | Next.js server actions (`"use server"` functions called from client components) | 1,286,781 (`"use server"`) | (in `next`) | 0 | handled as a `calls` edge (no route: Next gives an action no URL of its own). A form's `action`/`formAction` and `useActionState`'s action count as calls, and the browser's calls (those, or a call in a `"use client"` file) are labeled `server action`. Not handled: actions defined inside a component, calls from client-only modules without `"use client"`, actions passed through props. Not labeled in the eval (not an HTTP request in the repo's code). The viewer shows it as "calls · server action" (M5C.3a2) | ADR-0203; `calls.ts` |
| 5 | TanStack Query (`useQuery({ queryKey, queryFn })`, `useMutation({ mutationFn })`) | 1,048,448 (`QueryClientProvider`, about one per app) | `@tanstack/react-query` 254,287,015; `react-query` (v3) 6,533,385 | 3 | partial: a `queryFn` or `mutationFn` is read like any function, so the `fetch`, axios, or wrapper call inside it resolves; a URL read from the key in its context is read at each hook since M5C.3f (row 12). Not handled: the positional `useQuery(key, fn)`, `useQueries`, and `QueryClient` methods (`fetchQuery`, `prefetchQuery`) | ADR-0196 |
| 6 | axios interceptors (`x.interceptors.request.use(…)`) | 653,536 (`"interceptors.request.use"`) | (in `axios`) | 2 | not read. That's correct when they only set headers or retry on 401, as both eval repos' do (foodie retries a 401; nextjs-prisma-boilerplate's are commented out). An interceptor that rewrites `config.url` or `baseURL` isn't followed. No task: a code search can't count the URL-rewriting kind, and the eval set has none | `http.ts` "not handled" |
| 7 | ofetch (`ofetch(url, { method, baseURL })`, `ofetch.create`) | 348,608 (identifier `ofetch`; also counts Vue/Nuxt projects, outside v1's React frontends) | `ofetch` 88,754,211 (mostly through Nuxt/unjs) | 0 | handled since M5C.3c: `ofetch`/`$fetch` imported from `ofetch`, `x(url, options)`, `x.raw`, `x.native`, and `create()` instances (their `baseURL` and `method` defaults), joined like ofetch's `withBase`. Not handled: Nuxt's global `$fetch`/`useFetch` (Vue), `require`, `createFetch`, `onRequest` interceptors | ADR-0205; `http.ts` |
| 8 | SWR (`useSWR(key, fetcher)`, `SWRConfig`'s `fetcher`) | 291,869 (`useSWR`) | `swr` 78,623,930 | 1 | handled: the fetcher is inlined at the hook with each key. Not handled: method fetchers, nested named fetchers, and array keys (which stay `DYNAMIC_URL`) | ADR-0193, ADR-0194; `wrappers.ts` |
| 9 | RTK Query with `fetchBaseQuery({ baseUrl })` | 96,720 (`fetchBaseQuery`) | `@reduxjs/toolkit` 138,320,163 (all Redux users) | 1 | handled | ADR-0196 |
| 10 | ky (`ky.get(url)`, `ky.create({ prefixUrl })`, `ky.extend`) | 35,520 (`"import ky"`) | `ky` 28,733,005 | 0 | handled since M5C.3e: the `ky` default export, `x(url, options)`, `x.get|post|put|patch|delete|head`, and `create`/`extend` instances (their `method` and base defaults), with ky 1's `prefixUrl` (a URL starting with `/` shown as failing) and ky 2's `prefix` and `baseUrl`, each joined as ky does. Not handled: `require`, `ky-universal`, `ky.query`, `hooks.beforeRequest`, more than one base option at once (unresolved, saying so) | ADR-0207; `http.ts` |
| 11 | RTK Query with a custom base query (a re-auth wrapper around `fetchBaseQuery`, typed `BaseQueryFn`) | 9,195 (`BaseQueryFn`) | (in `@reduxjs/toolkit`) | 1 (Recipen, all 25 of its call sites) | handled since M5C.2 when the wrapper passes its arguments on unchanged to one `fetchBaseQuery` (RTK's re-auth example), and its own calls of the `fetchBaseQuery` result are requests. A wrapper that rewrites, hands on, or splits its arguments stays an unresolved node per endpoint (M5B.7b) | ADR-0196, ADR-0201 |
| 12 | TanStack Query key in context: `queryFn: ({ queryKey }) => fetch(queryKey[0])`, a `QueryClient`'s default `queryFn` | 3,850 (`"queryFn: ({ queryKey"`) | (in row 5) | 0 | handled since M5C.3f: `useQuery`, `useSuspenseQuery`, `useInfiniteQuery`, their prefetch forms, `queryOptions`, and `infiniteQueryOptions` (from `@tanstack/react-query` or `react-query`) call their `queryFn` (or every `QueryClient`'s same default, at `heuristic`) with the options, so `queryKey[0]`, `({ queryKey: [path, id] })`, and `ctx.queryKey[0]` read the hook's key. Not handled: `.join()` on the key, computed indexes, key factories, options built by a call or spread (those stay `DYNAMIC_URL`) | ADR-0196 (amendment); `wrappers.ts`, `url.ts` |
| — | Repo-defined wrappers (`api.get(path)` over `fetch` or axios) | can't be counted with a code search (any name, any shape) | — | at least 3 (WealthWise's path-taking `fetch` wrapper, foodie's wrapper over `axios(config)`, twitter-clone's SWR fetcher; EVALUATION.md §1) | partial: inlined one level deep, including `const` object methods and whole-config parameters. A wrapper calling a wrapper is `WRAPPER_DEPTH`, and destructured parameters aren't bound | ADR-0032, ADR-0159, ADR-0160, ADR-0164; `wrappers.ts` "not handled" |

Clients mostly used by servers to call other services (`got` 163,331,838 and `superagent` 96,172,686 downloads; `XMLHttpRequest`, `EventSource`) are left out of the ranking. A frontend rarely calls its own backend through them, and they stay listed under `http.ts` "not handled". Socket.io and WebSocket clients aren't HTTP requests (EVALUATION.md §1 doesn't label them).

## Receiving side: how backends take requests

| # | Pattern | Code search (files) | npm, last month | Eval repos (of 12) | Status | Where it's decided |
|---|---|---|---|---|---|---|
| 1 | Express apps, routers, and middleware (`express()`, `Router()`, `x.get(path, h)`, `x.route(path)`, `x.use(prefix, router)`) | 5,070,404 (`"express.Router"`); 3,360,184 (`"import express"`) | `express` 590,925,414 | 10 | handled: mounts composed across files, routers passed to functions, routers loaded from a folder listing. Partial: routers imported from other workspace packages or kept in collections, and dynamic paths (shown as `DYNAMIC_ROUTE`) | ADR-0026, ADR-0093, ADR-0162; `express.ts` |
| 2 | Next.js App Router route handlers (`app/**/route.ts` exporting `GET`, `POST`, …) | 3,557,376 (`"export async function GET"` in `filename:route.ts` 3,301,376 + `filename:route.js` 256,000) | `next` 275,607,626 (all of Next) | 2 | handled | ADR-0027; `next.ts` |
| 3 | Dev proxies between a SPA and its API: Vite `server.proxy` (with or without `rewrite`), CRA's `"proxy"` | 549,376 (`proxy` in `filename:vite.config.ts` 308,224 + `.js` 241,152; any mention) | — | 1 (foodie's CRA `"proxy"`, which can't rewrite paths) | handled since M5C.3b: a root-relative request is matched by the path the proxy sends (a `path.replace(…)` rewrite applied, the target's path in front), at `heuristic` in every service; a target outside the repo is an external call. Not handled: which service a loopback port belongs to (every service is a candidate), regex keys, `bypass`, CRA's `setupProxy.js`, webpack-dev-server. A rewrite of another shape is unresolved with a reason | ADR-0204; `devProxy.ts` |
| 4 | Next.js pages router API routes (`pages/api/**`, `req.method` guards) | 360,132 (`NextApiRequest`, TypeScript only; 145,920 of them under `path:pages/api`) | (in `next`) | 3 | handled, including negated method guards | ADR-0027, ADR-0195; `next.ts` |
| 5 | `next.config` `rewrites` and `basePath` | 86,656 (`rewrites` in `filename:next.config.js` 25,600 + `.mjs` 22,272 + `.ts` 38,784) | (in `next`) | 0 | handled since M5C.3d: a literal `basePath` puts the app's routes and pages under it for matching, and the app's own root-relative requests go through static `rewrites` in Next's order (`beforeFiles`, static files, `afterFiles`, dynamic routes, `fallback`), to another path of the app, a server in the repo (`heuristic`), or an external host. Not handled: a computed `basePath`, conditional (`has`/`missing`) or code-built rewrites, chained rewrites, `i18n`, and other services' requests through the app. A destination that isn't read is unresolved with a reason | ADR-0206; `nextConfig.ts` |
| 6 | next-connect routers in `pages/api` | 19,218 (`"next-connect"`) | `next-connect` 583,148 | 1 | handled | ADR-0191; `next.ts` |

## The gaps, in the order they're planned

C1 comes first, as Abhinav asked on #18. After it, the gaps follow the code search count of the form that isn't handled:

1. **M5C.2: RTK Query custom base queries** (row 11; 9,195 files; Recipen's 25 call sites). Done: ADR-0201.
2. **M5C.3a: Next.js server actions** (row 4; 1,286,781 files). Done: ADR-0203 keeps them as `calls` edges, adds form and `useActionState` references, and labels the browser's calls `server action`; EVALUATION.md doesn't label them. The viewer shows it as "calls · server action" (M5C.3a2).
3. **M5C.3b: Vite and CRA dev proxies** (receiving row 3; 549,376 config files mention `proxy`). Done: ADR-0204 reads Vite's `server.proxy` and CRA's `"proxy"` from syntax and matches the path the proxy sends.
4. **M5C.3c: ofetch** (row 7; 348,608). Done: ADR-0205 reads ofetch's calls and `create()` instances with the axios tracer and joins the base like ofetch's `withBase`.
5. **M5C.3d: `next.config` `rewrites` and `basePath`** (receiving row 5; 86,656). Done: ADR-0206 reads both from the config's syntax and applies them in the matcher; the route nodes keep their file-system paths.
6. **M5C.3e: ky** (row 10; 35,520). Done: ADR-0207 reads ky's calls and `create`/`extend` instances with the shared tracer, joining ky 1's `prefixUrl` and ky 2's `prefix` and `baseUrl` as each does.
7. **M5C.3f: TanStack Query key in context** (row 12; 3,850). Done: ADR-0196's amendment binds a `queryFn`'s context to the hook's options on SWR's hook path, so the key's elements are read at each hook, and a `QueryClient`'s default `queryFn` is used at `heuristic`.

**Not planned as tasks:**
- **The partial edges of handled patterns:** destructured axios instances, wrappers nested more than one level, routers in other workspace packages. None of them can be counted with a code search, and the eval set no longer misses any of them. A fresh sample (M5C.5) that misses one will show it.
- **URL-rewriting axios interceptors** (row 6): there's no usage count for that kind, and none in the eval set.

## After batch 4 (M5C.6)

Batch 4's blind run (M5C.5c) measured precision 94.4%, below the 95% floor, and recall 51.1%. Its 15 causes are in [`2026-11-batch4-diagnosis.md`](../eval/results/2026-11-batch4-diagnosis.md), by letter. Abhinav's decision on #18 (2026-11-05, option 2): fix the precision causes first, then the general recall patterns ranked by misses, only patterns that show up outside batch 4. Batch 4 counts as seen from then on, and a fresh batch 5 is drawn by the same rule (ADR-0208) and scored once, blind.

**Planned, in order** (PROGRESS.md M5C.7a–g, then M5C.8):

1. **M5C.7a, J (6 FP):** a wrapper that forwards the caller's options through a rest spread loses the caller's `method`, so each call matched every method. **Done** (ADR-0033's M5C.7a amendment): the method is read through a rest element, and an unread method between routes of different methods is unresolved; batch 4 precision 94.4% → 97.4%.
2. **M5C.7b, I (4 FP, 4 FN):** a pages-router handler exported through a wrapper (`withMiddleware("…")(handler)`) stays `ALL`, though it gates on `req.method`. **Done** (ADR-0195's M5C.7b amendment): the method checks are read from the last argument that is a repo function, through nested wrappers and `const`s, and an unfollowable wrapper keeps `ALL` with `NEXT_WRAPPED_HANDLER`; batch 4 precision 97.4% → 99.5%, recall 51.1% → 52.2%.
3. **M5C.7c, O (1 FP):** a wholly unknown path after a prefix (`/api/{}`) matched only a SPA catch-all. **Done** (ADR-0033's M5C.7c amendment): a route with no literal segment (`/*splat`, Express `*`) never takes a wholly unknown segment, so such a request is `NO_MATCHING_ROUTE` naming the catch-all; a catch-all under a literal (`pages/api/[...slug]`) still takes one; batch 4 precision 99.5% → 100.0%, recall unchanged at 52.2%.
4. **M5C.7d, E + H (24 FN):** URLs from repo functions that only build a string from their parameters, including object-literal arrow properties and functions behind React's `useCallback`/`useMemo`. This is the calling side's twin of the repo-defined wrapper row (ADR-0032).
5. **M5C.7e, C (22 FN):** source files at a workspace monorepo's root (`tests/`, `scripts/`) that belong to no package.
6. **M5C.7f, D (21 FN):** a path-taking wrapper calling another one ("wrappers nested more than one level" above, now planned).
7. **M5C.7g, G (10 FN):** a nested `tsconfig.json`/`jsconfig.json` with its own `paths`, in a folder that isn't a package.

Before fixing a recall pattern (4–7), its task first shows it outside batch 4: a code search count (query and date in `usage/`) or a repo in the earlier eval sets. One that can't be shown is recorded here and not fixed.

**Not planned, and why:**
- **A (50 FN): a base passed through a repo function that changes it** (`normalizeBaseUrl(env || fallback)` trims a trailing `/api`). Evaluating arbitrary string code (`replace`, regexes) isn't static reading of a URL; M5C.7d covers only functions that build a string from their parameters. It stays `DYNAMIC_URL`, visible at each site.
- **B (28 FN): a base read from a JSON file the app fetches at runtime.** The value is decided at deployment (a ConfigMap replaces the file). Runtime-only, shown as `DYNAMIC_URL`.
- **F (10 FN): a generated class client** (`this.request({ path, method })` on a `this.baseUrl` field), and **K (2 FN): a base set from a constructor argument.** Both need values followed through class instances from every `new`; one repo each, and neither has a usage count yet. A fresh sample that misses them again will show it.
- **L (3 FN): a path segment typed as a union of string literals,** and **M (1 FN): SWR's global fetcher from `SWRConfig`.** One repo, few misses; L would read types as values, which ADR-0166 does only for values in the code. Revisit if batch 5 misses them.
- **N (1 FN): an env base set only in a committed `.env`.** By design: SECURITY.md T5 and ADR-0202 read only example env files.
