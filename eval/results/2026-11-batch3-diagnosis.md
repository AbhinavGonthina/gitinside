# Held-out batch 3: why 25 labels are missed (M5B.6)

Diagnosis of held-out batch 3's first and only blind measurement, in [`2026-11-03-0.1.0.md` at `9dc9b2a`](https://github.com/AbhinavGonthina/gitinside/blob/9dc9b2a/eval/results/2026-11-03-0.1.0.md#held-out-batch-3-unseen) (GitInside `d1e2477`, the commit that pinned and labeled `nidhish-nayak/trendz`; Recipen's labels were committed earlier in `a227259`): precision 100.0% (45 of 45 predicted routes), recall 64.3% (45 of 70 real targets), no false positives, 25 false negatives, both `null` labels correctly abstained.

| Repo | Labels | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| `nidhish-nayak/trendz` | 46 | 45 | 0 | 0 | 100.0% (45/45) | 100.0% (45/45) |
| `Avinash905/Recipen` | 26 | 0 | 0 | 25 | n/a | 0.0% (0/25) |

This note explains the misses; it changes no score and starts no fix. Batch 3 stays unseen until a fix is chosen with these misses in view; from then on it counts as seen, like batches 1 and 2 (ADR-0168).

## Method

- After the scored run, analyzed Recipen's checkout in `eval/.repos/` at its pinned commit with the built `analyze()` (a scratch script under `eval/dist/`) and listed every HTTP prediction (`collectPredictions` from `eval/src/score.ts`) in `client/`, plus the route count.
- Compared each miss with the labeled call site and with ADR-0196 and `rtkEndpoint` in `packages/analyzer/src/http.ts`, which decide when an RTK Query endpoint is a request.

## Summary

| # | Root cause | FN | FP | Repo |
|---|---|---:|---:|---|
| C1 | RTK Query endpoints whose API's `baseQuery` is a repo function wrapping a `fetchBaseQuery` result (RTK's re-authorization pattern), not `fetchBaseQuery` itself: no endpoint is read as a request, and the wrapper's own `baseQuery("/auth/refresh", …)` isn't one either | 25 | 0 | Recipen |
| C2 | (found in M5C.2, behind C1) the `baseUrl` is an env var whose `/api` path prefix appears only in `client/.env.example`'s value, which isn't read | 25 | 0 | Recipen |

Every blind miss has cause C1; C2 hides behind it, on the same 25 sites. The server side is complete: all 24 of Recipen's Express routes are in the graph, so a fix to C1 alone would have targets to match. trendz needed nothing new: TanStack Query's `queryFn`/`mutationFn` are ordinary repo code (ADR-0196), and every call on its `axios.create({ baseURL: \`${config.serverUrl}/api\` })` instance and its three plain `axios.post` calls resolved, all `heuristic` (an env-named base).

## C1: a custom base query around `fetchBaseQuery` (25 FN)

- **What the code does.** `client/src/redux/apiSlice.js` builds `const baseQuery = fetchBaseQuery({ baseUrl: import.meta.env.VITE_SERVER_BASE_URL, … })`, then `const baseQueryWithReauth = async (args, api, extraOptions) => { let result = await baseQuery(args, api, extraOptions); … baseQuery("/auth/refresh", api, extraOptions) … }`, and `createApi({ baseQuery: baseQueryWithReauth, endpoints: () => ({}) })`. Four feature modules add 24 endpoints with `apiSlice.injectEndpoints({ endpoints: (builder) => ({ … builder.query({ query: … }) … }) })`. This is the shape of RTK Query's own documented re-authorization example ("Automatic re-authorization by extending fetchBaseQuery").
- **What the analyzer does.** ADR-0196 makes an endpoint a request only when the API's `baseQuery` is RTK's `fetchBaseQuery(…)` (directly, through a `const`, or inside `retry`), and says a custom base query isn't followed, because it may not be HTTP. `baseQueryWithReauth` is a custom function, so none of the 24 endpoints is read as a request, and the sites get no prediction at all (not even an unresolved node). The direct call `baseQuery("/auth/refresh", api, extraOptions)` calls the *result* of `fetchBaseQuery`, which the analyzer doesn't know as a request function, so `apiSlice.js:21` gets nothing either.
- **General form.** A base query that is a repo function whose first parameter reaches the first argument of a `fetchBaseQuery` result's call (as RTK's docs show) sends every endpoint's `args` through that `fetchBaseQuery`, so its `baseUrl` applies; and a call of a `fetchBaseQuery` result with a URL fixed there (a string, or `{ url, method }`) is itself a request. A fix would read both from RTK's contract with a fixture written from the documented example, not from this repo; what the wrapper does besides forwarding (headers, retries, a refresh) doesn't change the URL. A wrapper that rewrites `args` before forwarding them would stay unread.
- **Since the blind run (M5B.7b, `980f536`).** Endpoints under a base query that isn't `fetchBaseQuery` are now shown as unresolved `DYNAMIC_URL` nodes saying the base query isn't followed (ADR-0196's amendment), so 24 of these 25 sites have an unresolved prediction and the report's "Missing" for Recipen is 1 (`apiSlice.js:21`). The scores are unchanged: all 25 are still false negatives until the general form above is implemented (M5B.6b, #18).
- **Fixed in M5C.2 (ADR-0201).** The general form above is implemented from RTK's documented example with its own fixture (`fixtures/rtk-query/store/session.ts`); batch 3 counts as seen from then on. All 25 sites are now read through the wrapper (each endpoint's own URL and method, joined to the `fetchBaseQuery`'s `baseUrl`), but the score is unchanged: see C2.

## C2: the base's path prefix is only in an env value (25 FN, found in M5C.2)

- **What the code does.** `baseUrl` is `import.meta.env.VITE_SERVER_BASE_URL`, with no fallback in code. Its value appears only in `client/.env.example`: `http://localhost:5000/api`. The endpoints' URLs are `/auth/login`, `/blog/${blogId}`, …, and the server mounts its routers under `/api` (`/api/auth`, `/api/blog`, …).
- **What the analyzer does.** `VITE_SERVER_BASE_URL` ends in `BASE_URL`, so it reads as an API base (ADR-0165) and the requests are matched at `heuristic`, but against `/auth/login`, not `/api/auth/login`: env values are never read (SECURITY.md T5), so the `/api` prefix is unknown and every request is `NO_MATCHING_ROUTE`. No route is guessed.
- **Correction.** The first version of this note said the env-only base was "not a cause", because the env-name rule resolves such bases elsewhere in the eval (wanderlust, RishiBakshii). That was only checked by name; those repos' env values carry no path, and this one's does. It became visible once C1 was fixed.
- **General form.** A committed example env file (`.env.example`) holding a URL whose path is a prefix (`/api`) that every request under that base needs. Reading it means changing T5 (read the path of a URL value in a committed example file, never its host, credentials, or query, and never draw it into graph strings), or matching a path as a suffix of a route under an env base (a guess T5 doesn't need, but one that can pick the wrong route). Either needs an ADR first: M5C.2b.
- **Fixed in M5C.2b (ADR-0202).** The first option, narrowed: only example env files (`.env.example`, `.sample`, `.template`) are read, only a URL value's path (≤ 4 plain segments), only for an API-named env base, and only inside the matcher, which tries the path in front first and then the request alone. No graph string holds it (SECURITY.md T5, `fake-secrets`). Fixture `env-example-prefix`.

## Not a cause

- The RTK endpoints' methods and URLs: with C1 fixed, each request carries the labeled method and path after the base.

## Other observations (not scored)

- **Abstentions.** Recipen's Cloudinary upload (`uploadImage.js:24`, an env-only URL) is `unresolved NO_MATCHING_ROUTE`, and trendz's moderation request (`moderator.util.ts:27`, `process.env.MOD_URL`) is unresolved too: both correct abstentions for their `null` labels.
- **Confidence.** All 45 true positives are `heuristic`: trendz reaches its server only through `config.serverUrl`, an env var picked by `import.meta.env.MODE`.
