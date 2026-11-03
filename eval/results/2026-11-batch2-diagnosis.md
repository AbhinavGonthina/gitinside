# Held-out batch 2: why 20 labels are missed (M5A.4a3)

Diagnosis of held-out batch 2's first and only blind measurement, in [`2026-11-01-0.1.0.md`](2026-11-01-0.1.0.md#held-out-batch-2-unseen) (GitInside `915a661`): precision 45.8% (11 of 24 predicted routes), recall 35.5% (11 of 31 real targets), 13 false positives, 20 false negatives, both `null` labels correctly abstained.

This note explains the misses; it changes no score and starts no fix. M5A's rule for this batch is that its misses don't become M5A fixes (PROGRESS.md M5A.4a3). If a later milestone fixes either pattern, it needs its own fixture written from the pattern's general form, and batch 2 then counts as seen (ADR-0168).

## Method

- After the scored run, analyzed both checkouts in `eval/.repos/` at their pinned commits with the built `analyze()` (a scratch script under `eval/dist/`) and dumped every service, route, unresolved node, and `http`/`external_call` edge with its sites.
- Compared each miss with the labeled call site and with the code that decides it (`packages/analyzer/src/next.ts` for routes, `http.ts`/`wrappers.ts` for requests).

## Summary

| # | Root cause | FN | FP | Repo |
|---|---|---:|---:|---|
| B1 | `next-connect` handlers (`const handler = nc(); handler.get(…); handler.post(…); export default handler`): the analyzer doesn't read the method registrations, so each `pages/api` file is one `ALL` route | 13 | 13 | nextjs-prisma-boilerplate |
| B2 | A library invokes the repo's fetcher with a key the repo hands it (`useSWR(\`/api/posts/${postId}\`, fetcher)`, `fetcher = (url) => axios.get(url)`): no repo code calls `fetcher`, so the request is one `DYNAMIC_URL` node inside it and the `useSWR` sites get nothing | 7 | 0 | twitter-clone |

Every miss has exactly one cause. Fixing B1 alone would turn 13 FN into TPs and remove all 13 FPs; B2 alone, 7 FN.

## B1: next-connect method registrations (13 FN, 13 FP)

- **What the code does.** `lib-server/nc.ts` exports `apiHandler = () => nc(ncOptions)`, whose `onNoMatch` answers 405. Each `pages/api` file creates `const handler = apiHandler()`, registers `handler.get(…)`, `handler.post(…)`, `handler.patch(…)`, `handler.delete(…)`, and default-exports `handler`. So `pages/api/posts/[id].ts` serves exactly GET, PATCH, and DELETE.
- **What the analyzer does.** `next.ts` reads a pages-router handler's methods only from `req.method` comparisons inside a default-exported function. A default-exported *value* (a router object) has no such function, so the file gets one `ALL` route anchored at `export default handler` (e.g. `ALL /api/posts/:id` at `[id].ts:84`). The `Patterns not handled` list in `next.ts` names wrapped default exports (`withAuth(h)`) but not router objects.
- **What matched.** All 13 requests are predicted at the right call site, with the right file and path, `exact`: the `Routes.API.*` constants, the `${Routes.API.POSTS}${id}` templates, the instance without `baseURL`, and `profile.ts` over `[id].ts` all resolve. Only the method differs (`ALL` vs the labeled `GET`/`POST`/`PATCH`/`DELETE`), and scoring compares method + path (EVALUATION.md §1), so each counts as a wrong route plus a miss.
- **General form.** A pages-router API file whose default export is a router object built by `next-connect` (`nc()` in v0, as here; v1's `createRouter()` exports `router.handler()` instead, a different shape), with methods registered by calls on it (`.get(…)`, chained `nc().get(…).post(…)`, `.use(…)` not a method). A fix would read those calls the way `express.ts` reads `router.get(…)`, with a fixture written from that form, not from this repo.
- **Not a cause.** The custom server's `server.all('*', handle)` became a route `ALL /*` in `server/index.ts`, but no request matched it over the Next routes, so the pass-through reading (EVALUATION.md §1) cost nothing here.

## B2: library-invoked fetcher (7 FN)

- **What the code does.** `libs/fetcher.ts` is `const fetcher = (url: string) => axios.get(url).then((res) => res.data)`. Seven hooks hand it to SWR with a key: `useSWR("/api/current", fetcher)`, `useSWR(postId ? \`/api/posts/${postId}\` : null, fetcher)`, and so on. SWR calls `fetcher(key)`; no repo code does.
- **What the analyzer does.** `fetcher` takes the whole URL as a parameter, so it's a wrapper, and wrapper requests are reported at the wrapper's callers. It has none, so its request stays in place as `unresolved DYNAMIC_URL` at `libs/fetcher.ts:5` (not scored: no label there, EVALUATION.md §1's M5A.4a2 rule), and the seven `useSWR` sites get no prediction.
- **General form.** A call to a known data-fetching hook (`useSWR(key, fetcher)`, `useSWRImmutable`, SWR's `useSWRInfinite` with a key function; possibly react-query's `useQuery({ queryKey, queryFn })` only when `queryFn` receives the key) whose fetcher argument resolves to a repo wrapper: inline the wrapper at the hook call with the key as its URL argument. Unlike B1, this needs a list of libraries and their argument contracts, which is a design decision (ADR), not just a detector.

## After M5B.1 and M5B.2: one miss left, behind B2 (B3)

With B1 (M5B.1, ADR-0191) and B2 (M5B.2, ADR-0193) fixed, batch 2 scores precision 100.0% (30/30) and recall 96.8% (30/31) ([`2026-11-03-0.1.0.md`](2026-11-03-0.1.0.md#held-out-batch-2-unseen)). Six of B2's seven hooks now resolve. The seventh, `hooks/useFollowingDetails.ts:6` (`useSWR(\`/api/following?username=${username}\`, fetcher)`), now predicts `GET /api/following` at the hook, but it gets `NO_MATCHING_ROUTE`: a second cause that B2 hid, since nothing was predicted there before.

- **What the code does.** `pages/api/following.ts` serves the request inside `if (req.method !== "POST" && req.method !== "DELETE" && req.method !== "PUT") { … }`, so every method except those three reaches the body (the label is `ALL`, as EVALUATION.md §1 labels a handler that doesn't pick one method).
- **What the analyzer does.** `next.ts` collects the methods compared with `req.method` and makes one route per method, so the file gets `POST`, `DELETE`, and `PUT`, the three methods the guard *excludes*, and no route the `GET` could match.
- **General form (B3).** A `req.method !==` comparison (or a negated `===`) whose block serves the request means "every method but these". A fix reads the comparison's polarity, as a fixture written from that form, not from this repo; planned as M5B.2c.

## Other observations (not scored)

- **Services.** With no root `workspaces`, the boilerplate's `prisma/` and `tests-e2e/` folders have their own `package.json`, so M5A.3f's sibling-folder rule makes them services next to the app. That is the documented rule; whether a test or tooling package should be a service in the diagram is a viewer question, not an accuracy one.
- **Unresolved imports.** Four `UNKNOWN_SYMBOL` nodes in `tests-e2e/` are extensionless imports of the JSON file `cypress/fixtures/fakeUser.json` (`import … from '../fixtures/fakeUser'`), which the analyzer doesn't resolve. They are import facts, not HTTP predictions; not investigated further.
- **Confidence.** All 11 true positives and all 13 false positives are `exact`: both repos call their own Next.js app by root-relative path, which needs no heuristic. A wrong method at `exact` confidence is the worse failure, since the diagram draws it as certain.
