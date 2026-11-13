# Held-out batch 4: why 176 labels are missed and 11 predictions are wrong (M5C.5c)

Diagnosis of held-out batch 4's first and only blind measurement, in [`2026-11-04-0.2.0.md` at `0d24196`](https://github.com/AbhinavGonthina/gitinside/blob/0d24196/eval/results/2026-11-04-0.2.0.md#held-out-batch-4-unseen) (GitInside `0b64502`; labels committed in M5C.5b1–b4, before the analyzer first ran on any of the 16 repos). Precision is 94.4% (184 of 195 predicted routes), below the 95% floor. Recall is 51.1% (184 of 360 real targets), below the 80% target. 6 of 16 repos are mapped completely (37.5%). All 37 `null` labels got no route (20 abstentions, 17 sites with no prediction).

| Repo | Labels | TP | FP | FN | Precision | Recall | Causes |
|---|---:|---:|---:|---:|---:|---:|---|
| `fiveman1/strafes-site` | 44 | 0 | 1 | 21 | 0.0% (0/1) | 0.0% (0/21) | D, O |
| `gruz0/checkmvp` | 9 | 7 | 0 | 2 | 100.0% (7/7) | 77.8% (7/9) | K |
| `hoangsonww/Tic-Tac-Toe-Fullstack-Game` | 20 | 12 | 0 | 8 | 100.0% (12/12) | 60.0% (12/20) | H |
| `jigar-sable/instagram-mern` | 28 | 28 | 0 | 0 | 100.0% | 100.0% | complete |
| `jogeshwar01/tesior-web` | 24 | 21 | 0 | 0 | 100.0% | 100.0% | complete |
| `nateherkai/snagtime` | 70 | 48 | 0 | 22 | 100.0% (48/48) | 68.6% (48/70) | C |
| `panshak/accountill` | 27 | 25 | 0 | 0 | 100.0% | 100.0% | complete |
| `pnzaou/mern-starter-cli` | 11 | 1 | 0 | 10 | 100.0% (1/1) | 9.1% (1/11) | G |
| `prasadhonrao/devcamper` | 33 | 0 | 0 | 28 | n/a | 0.0% (0/28) | B |
| `Prathamesh-B/notx` | 6 | 6 | 0 | 0 | 100.0% | 100.0% | complete |
| `premieroctet/next-crud` | 16 | 5 | 0 | 11 | 100.0% (5/5) | 31.3% (5/16) | F, N |
| `SujalXplores/v0.diy` | 28 | 4 | 6 | 20 | 40.0% (4/10) | 16.7% (4/24) | E, J, L, M |
| `suryansh00001/IceLink` | 17 | 17 | 0 | 0 | 100.0% | 100.0% | complete |
| `Tanaka0127939/Shopify-Nextjs-Prisma-app` | 6 | 2 | 4 | 4 | 33.3% (2/6) | 33.3% (2/6) | I |
| `vijayshikhare/community-resource-board` | 50 | 0 | 0 | 50 | n/a | 0.0% (0/50) | A |
| `wrujel/airbnb-clone` | 8 | 8 | 0 | 0 | 100.0% | 100.0% | complete |

This note explains the misses. It changes no score and starts no fix. Batch 4 stays unseen until a fix is chosen with these misses in view; from then on it counts as seen, like batches 1–3 (ADR-0168).

## Method

- After the scored run, analyzed each checkout in `eval/.repos/` at its pinned commit with the built `analyze()` (a scratch script under `eval/dist/`), and listed the services, routes, unresolved nodes (reason, expression, detail), `http` edges with their sites, and warnings.
- Read the code at each missed site and at the helper or base it goes through, and compared it with the analyzer's documented "not handled" lists (`http.ts`, `next.ts`) and the ADRs.
- Counted each miss under exactly one cause; the FN column sums to 176 and the FP column to 11.

## Summary

Ranked by false negatives. "Visible as" says what the user sees today. Most causes leave the request visible: an unresolved node at the site, a warning, or a prediction at the helper's own site. G leaves only an unresolved import, and D's callers and M's hook get nothing at their own sites.

| # | Root cause | FN | FP | Repo | Visible as |
|---|---|---:|---:|---|---|
| A | An axios `baseURL` passed through a repo function (`normalizeBaseUrl(env \|\| fallback)`) | 50 | 0 | community-resource-board | `DYNAMIC_URL` at each site |
| B | The base is read at runtime from a JSON file the app fetches (`fetch('/config/config.json')`) | 28 | 0 | devcamper | `DYNAMIC_URL` at each site |
| C | Repo-root `tests/` and `scripts/` in a workspace monorepo belong to no package, so they aren't analyzed | 22 | 0 | snagtime | `FILES_OUTSIDE_SERVICE` warnings |
| D | A path-taking helper calling another path-taking helper (`tryGetRequest` → `tryRequest` → `fetch("/api/" + url)`) | 21 | 0 | strafes-site | at the inner helper's sites only |
| E | The URL is the result of a repo path-builder function (`chatUrls.files(chatId)`) | 16 | 0 | v0.diy | `DYNAMIC_URL` at each site |
| F | A generated class client: endpoint methods call `this.request({ path, method })` on a `this.baseUrl` field | 10 | 0 | next-crud | `DYNAMIC_URL` at the helper only |
| G | A `paths` alias (`@/*`) declared in a nested `jsconfig.json` of a folder that isn't its own package | 10 | 0 | mern-starter-cli | the import is `UNKNOWN_SYMBOL` |
| H | A URL helper defined through React's `useCallback((path) => \`${API_BASE}${path}\`, …)` | 8 | 0 | Tic-Tac-Toe | `DYNAMIC_URL` at each site |
| I | A pages-router handler exported through a wrapper (`withMiddleware("…")(handler)`), so its `req.method` tests aren't read | 4 | 4 | Shopify-Nextjs-Prisma-app | the right file at `ALL` |
| L | A path segment typed as a union of string literals (`/api/chats/import/${kind}`) | 3 | 0 | v0.diy | `NO_MATCHING_ROUTE` |
| K | A base held in a class field set from a constructor argument (`new IdeaService(env.IDEA_SERVICE_API_BASE)`) | 2 | 0 | checkmvp | `DYNAMIC_URL` at each site |
| M | `useSWR(key)` with no fetcher, using `<SWRConfig value={{ fetcher }}>`'s | 1 | 0 | v0.diy | nothing at the site |
| N | An env base whose only value is in a committed `.env` (not an example file) | 1 | 0 | next-crud | `NO_MATCHING_ROUTE` |
| J | A wrapper passing the caller's `method` on through a rest spread (`const { json, headers, ...rest } = init; fetch(url, { ...rest })`) | 0 | 6 | v0.diy | every method, `AMBIGUOUS` |
| O | A wholly dynamic path (`/api/{}`) matched to the server's SPA catch-all `GET /*splat` | 0 | 1 | strafes-site | a wrong route |
| | **All** | **176** | **11** | | |

The two largest causes (A and B, 78 misses) are single repos whose one base reaches every request, as Recipen's did in batch 3. Ten of the 15 causes are calling-side, three receiving-side or structural (C, G, I), and two are matcher precision (J, O).

## Calling side

- **A, a base through a function (50 FN).** `frontend/src/services/api.jsx` sets `const API_BASE_URL = normalizeBaseUrl(process.env.REACT_APP_API_URL || (… ? 'https://…onrender.com' : 'http://localhost:5000'))` and `axios.create({ baseURL: API_BASE_URL })`. `normalizeBaseUrl` trims a trailing slash and a trailing `/api`. The URL normalizer doesn't evaluate calls of repo functions, so the base reads as runtime-only and every request on the instance (20 helpers in `api.jsx` and 30 inline calls in pages) is `DYNAMIC_URL`. The server mounts its routers under `/api`, and every request path already starts with `/api/`. A general form would follow a one-expression string function of its argument (like wrapper inlining, ADR-0032's one level), or pass the argument through a call whose result is unknown only as a suffix change. Neither is obviously safe: here the function changes the end of the string.
- **B, a base from a fetched JSON file (28 FN).** `src/webapp/src/utils/configService.js` does `fetch('/config/config.json')`, reads `json[process.env.NODE_ENV].react_app_devcamper_base_api_uri`, and `fetchApiEndPoint(path)` returns `` `${api}${endpoint}` ``. The labels follow the committed `public/config/config.json` to the repo's own server (`/api/v1`). Only reading that file as a response body would match these; the value really is decided at runtime (a Kubernetes ConfigMap replaces the file in deployment, per the label notes). This is closest to "only known at runtime" and is shown as such.
- **D, a helper calling a helper (21 FN).** In `client/src/api/api.ts`, `tryRequest(url, init, timeout)` does `fetch("/api/" + url, …)`, and `tryGetRequest(url, params)` / `tryPostRequest(url, params)` call it with `url` or `` `${url}?${query}` ``. Wrapper inlining goes one level (ADR-0032), so the requests are reported at `tryGetRequest`'s and `tryPostRequest`'s own calls (lines 32 and 36), as `/api/{}`, and the 21 callers with literal paths (`tryGetRequest("user/rank/" + userId)`) get nothing. They don't get a `WRAPPER_DEPTH` node either: the inner calls are matched (line 36 is `NO_MATCHING_ROUTE`, line 32 cause O), not left as "a parameter of the calling function". Worth checking against ADR-0032 before any fix.
- **E, path-builder functions (16 FN).** v0.diy's `chatUrls` object holds arrow functions returning templates (`messages: (chatId) => \`${chatPath(chatId)}/messages\``), and callers send `requestJson(chatUrls.files(chatId), …)` or `fetch(chatUrls.resume(chatId), …)`. The normalizer reads a call as runtime, so each is `DYNAMIC_URL`. The general form is evaluating a repo function that only builds a string from its parameters, the URL-side twin of wrapper inlining.
- **F, a generated class client (10 FN).** `example/Api.ts` is a swagger-typescript-api client (labeled under ADR-0209): each endpoint method calls `this.request({ path: \`/users/${id}\`, method: "GET", … })`, and `request` calls `this.customFetch(\`${baseUrl || this.baseUrl || ""}${path}…\`)`. The helper's own site is `DYNAMIC_URL`, and the endpoint methods aren't read as callers of a path-taking helper, since the path arrives inside an object on `this`. It combines K (a class-held base) with a config-object helper.
- **H, a helper inside `useCallback` (8 FN).** `Board.tsx` defines `const apiUrl = useCallback((path: string) => \`${API_BASE}${path}\`, [API_BASE])` and calls `fetch(apiUrl("/realtime/move"), …)`. It's E's pattern (a URL from a repo string-builder) behind React's `useCallback(fn, deps)`, which returns `fn` itself (React's documented contract). A fix to E would need to read `useCallback`'s first argument (and `useMemo(() => fn)`'s result) as the function to reach these.
- **K, a constructor-argument base (2 FN).** `src/common/client/Idea/Service.ts` has `constructor(private readonly baseURL: string)` and fetches `` `${this.baseURL}/ideas` ``; it's built as `new IdeaService(env.IDEA_SERVICE_API_BASE)`, whose value is only in `.env.example` (`…/api`). Class-held bases aren't followed from construction sites. A fix would need the base at every `new` of the class, all agreeing.
- **L, a union-literal segment (3 FN).** `importChat` sends `` `/api/chats/import/${kind}` `` where `kind` is `"repo" | "zip" | "files"` by its type. The routes are three literal folders, so `{}` matches none and the site is `NO_MATCHING_ROUTE`. Reading a parameter's string-literal union type as a set of alternatives (like a ternary, ADR-0041 for labels) would match all three.
- **M, SWR's global fetcher (1 FN).** `useSWR<Chat[]>("/api/chats")` has no fetcher, and SWR then uses `SWRConfig`'s (`src/components/providers/swr-provider.tsx`). ADR-0193 follows only a fetcher passed to the hook, so nothing is predicted at the site; the provider's fetcher shows as `WRAPPER_DEPTH` at `swr-provider.tsx:12`.
- **N, a committed `.env` (1 FN).** `getServerSideProps` fetches `` `${process.env.API_URL}/users/${id}` `` and `API_URL` is set only in the committed `example/.env`. ADR-0202 reads only example files (`.env.example`, `.sample`, `.template`) and never `.env` (SECURITY.md T5), so this stays `NO_MATCHING_ROUTE` by design. Labels follow a committed `.env` (M5C.5b4's rule); the analyzer doesn't, on purpose.

## Receiving side and structure

- **C, root-level files outside every package (22 FN).** snagtime is a workspace monorepo with one package (`apps/web`). Its Playwright tests (`tests/e2e/`) and scripts (`scripts/load-check.mts`) sit at the repo root, which belongs to no workspace package, so they aren't analyzed, and the analyzer says so (`FILES_OUTSIDE_SERVICE`, 36 files under `scripts/` and 5 under `tests/`). EVALUATION.md's labeling rule counts tests and scripts as source (M5C.5b3), so these 22 are misses. A general form would treat the root `package.json` of a workspace as its own service when files sit outside every package.
- **G, an alias from a nested `jsconfig.json` (10 FN).** mern-starter-cli is one package at the root; its React template (`templates/client/`) has no `package.json` of its own, but has a `jsconfig.json` with `"paths": { "@/*": ["./src/*"] }`. The service's program uses the root's settings, so `import api from '@/lib/axios'` is `UNKNOWN_SYMBOL`, and the 10 `api.post('/auth/…')` calls in `authAPI` aren't seen as calls on the axios instance. The one TP is the refresh call inside `lib/axios.js` itself. A general form would load a nested `tsconfig.json`/`jsconfig.json` for the files under it.
- **I, a wrapped default export (4 FN, 4 FP).** `pages/api/apps/index.js` exports `withMiddleware("verifyRequest")(handler)`, and `handler` answers `GET` and `POST` and refuses the rest with a 400. `next.ts` lists "method checks in a wrapped default export (`export default withAuth(h)`)" as not handled, so the route stays `ALL`; the label rule (M5C.5b4: a method gate admits only its methods) labels it `GET`/`POST`. Each such site is one FP (`ALL`) and one FN. A general form would follow the wrapper's last call argument to the handler, as ADR-0195 reads the handler itself.

## Matcher precision (the 11 FP)

- **J, every method, `AMBIGUOUS` (6 FP).** `requestJson(url, init = {})` destructures `init` as `{ json, headers, ...rest }` and sends `fetch(url, { ...rest, headers, body })`. Wrapper inlining doesn't carry the caller's `method` through the rest spread, so each of the three `/api/user/v0-key` calls (GET, PUT, DELETE) matches all three routes, one level weaker and `AMBIGUOUS` (ADR-0033). That is 3 TP and 6 FP. ADR-0033 meant `AMBIGUOUS` for several equally good routes; here the method is unknown, not the route. Whether an unknown method should give an unresolved node instead of three edges is a precision question for an ADR.
- **O, the SPA catch-all (1 FP).** strafes-site's server ends with `app.get("*", …)` (`GET /*splat`) to serve the React app. `tryGetRequest`'s own site, `/api/{}`, matches only that route, `heuristic`. The site isn't labeled (its callers are), so it counts as one FP. A request whose whole path after a prefix is unknown matching only a catch-all is a guess the matcher could refuse.

## What the batch shows

- **Precision:** 6 of the 11 FPs are J (an unknown method spread through a wrapper), 4 are I (an `ALL` route that is really method-gated), and 1 is O. None is a wrong path: every FP has the right file and path.
- **Recall:** no single cause dominates as C1 did in batch 3. The largest two (A, B) are one repo each, and 78 of the 176 misses are in the two repos at 0%. Ranked by FN, the general patterns are values through repo functions (A, E: 66), runtime-only config (B: 28), code outside a package or its config (C, G: 32), helper depth (D, F: 31), React hooks or types (H, L, M: 12; H is E behind `useCallback`), a wrapped handler (I: 4), a class-held base (K: 2), and a committed `.env` (N: 1).
- **By design:** B (a fetched config) and N (a committed `.env`) would need values read at runtime or from files that T5 keeps unread. They're shown as unresolved, which the coverage plan allows ("what's only known at runtime or lives outside the repo shows as unresolved, never guessed").

## Other observations (not scored)

- **Abstentions.** All 20 abstentions at `null` labels were external hosts (9), `DYNAMIC_URL` (8), or `NO_MATCHING_ROUTE` (3); 17 more `null` sites got no prediction, all in strafes-site's server (its generated StrafesNET clients and its own outbound helpers).
- **Confidence.** 92 TP are `exact`, 4 `pattern`, and 88 `heuristic`. The 4 `exact` FPs are cause I (a file-system route at `ALL`), and the 7 `heuristic` FPs are J and O.
