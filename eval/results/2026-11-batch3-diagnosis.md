# Held-out batch 3: why 25 labels are missed (M5B.6)

Diagnosis of held-out batch 3's first and only blind measurement, in [`2026-11-03-0.1.0.md` at `08caa77`](https://github.com/AbhinavGonthina/gitinside/blob/08caa77/eval/results/2026-11-03-0.1.0.md#held-out-batch-3-unseen) (GitInside `cc035be`, the commit that pinned and labeled `nidhish-nayak/trendz`; Recipen's labels were committed earlier in `b8d86a1`): precision 100.0% (45 of 45 predicted routes), recall 64.3% (45 of 70 real targets), no false positives, 25 false negatives, both `null` labels correctly abstained.

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

Every miss has this one cause. The server side is complete: all 24 of Recipen's Express routes are in the graph, so a fix to C1 alone would have targets to match. trendz needed nothing new: TanStack Query's `queryFn`/`mutationFn` are ordinary repo code (ADR-0196), and every call on its `axios.create({ baseURL: \`${config.serverUrl}/api\` })` instance and its three plain `axios.post` calls resolved, all `heuristic` (an env-named base).

## C1: a custom base query around `fetchBaseQuery` (25 FN)

- **What the code does.** `client/src/redux/apiSlice.js` builds `const baseQuery = fetchBaseQuery({ baseUrl: import.meta.env.VITE_SERVER_BASE_URL, … })`, then `const baseQueryWithReauth = async (args, api, extraOptions) => { let result = await baseQuery(args, api, extraOptions); … baseQuery("/auth/refresh", api, extraOptions) … }`, and `createApi({ baseQuery: baseQueryWithReauth, endpoints: () => ({}) })`. Four feature modules add 24 endpoints with `apiSlice.injectEndpoints({ endpoints: (builder) => ({ … builder.query({ query: … }) … }) })`. This is the shape of RTK Query's own documented re-authorization example ("Automatic re-authorization by extending fetchBaseQuery").
- **What the analyzer does.** ADR-0196 makes an endpoint a request only when the API's `baseQuery` is RTK's `fetchBaseQuery(…)` (directly, through a `const`, or inside `retry`), and says a custom base query isn't followed, because it may not be HTTP. `baseQueryWithReauth` is a custom function, so none of the 24 endpoints is read as a request, and the sites get no prediction at all (not even an unresolved node). The direct call `baseQuery("/auth/refresh", api, extraOptions)` calls the *result* of `fetchBaseQuery`, which the analyzer doesn't know as a request function, so `apiSlice.js:21` gets nothing either.
- **General form.** A base query that is a repo function whose first parameter reaches the first argument of a `fetchBaseQuery` result's call (as RTK's docs show) sends every endpoint's `args` through that `fetchBaseQuery`, so its `baseUrl` applies; and a call of a `fetchBaseQuery` result with a URL fixed there (a string, or `{ url, method }`) is itself a request. A fix would read both from RTK's contract with a fixture written from the documented example, not from this repo; what the wrapper does besides forwarding (headers, retries, a refresh) doesn't change the URL. A wrapper that rewrites `args` before forwarding them would stay unread.
- **Not a cause.** The env-only `baseUrl` (`VITE_SERVER_BASE_URL`, no in-code fallback) resolves elsewhere in the eval by the API-base env-name rule (wanderlust, RishiBakshii); it was never reached here.

## Other observations (not scored)

- **Abstentions.** Recipen's Cloudinary upload (`uploadImage.js:24`, an env-only URL) is `unresolved NO_MATCHING_ROUTE`, and trendz's moderation request (`moderator.util.ts:27`, `process.env.MOD_URL`) is unresolved too: both correct abstentions for their `null` labels.
- **Confidence.** All 45 true positives are `heuristic`: trendz reaches its server only through `config.serverUrl`, an env var picked by `import.meta.env.MODE`.
