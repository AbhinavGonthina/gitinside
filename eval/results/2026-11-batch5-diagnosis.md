# Held-out batch 5: why 170 labels are missed and 20 predictions are wrong (M5C.8c)

Diagnosis of held-out batch 5's first and only blind measurement, in [`2026-11-05-0.2.0.md` at `ad64a5e`](https://github.com/AbhinavGonthina/gitinside/blob/ad64a5e/eval/results/2026-11-05-0.2.0.md#held-out-batch-5-unseen) (GitInside `7a3c57e`, after the M5C.7 fixes; labels committed in M5C.8b1–b4, before the analyzer first ran on any of the 16 repos). Precision is 93.5% (290 of 310 predicted routes), below the 95% floor. Recall is 63.0% (290 of 460 real targets), below the 80% target. 6 of 16 repos are mapped completely (37.5%). All 60 `null` labels got no route (58 abstentions, 2 sites with no prediction).

| Repo | Labels | TP | FP | FN | Precision | Recall | Causes |
|---|---:|---:|---:|---:|---:|---:|---|
| `BharathxD/DevCircle` | 19 | 14 | 0 | 2 | 100.0% (14/14) | 87.5% (14/16) | Y |
| `DOodle25/SyncUP` | 20 | 19 | 0 | 0 | 100.0% | 100.0% | complete |
| `dotnize/chessu` | 11 | 10 | 0 | 1 | 100.0% (10/10) | 90.9% (10/11) | T |
| `elyse502/ecommerce-app` | 16 | 10 | 0 | 6 | 100.0% (10/10) | 62.5% (10/16) | X |
| `erayendes/kortext` | 103 | 52 | 6 | 48 | 89.7% (52/58) | 52.0% (52/100) | S, Q |
| `Farbyte/lawson` | 10 | 5 | 0 | 0 | 100.0% | 100.0% | complete |
| `g089h515r806/nextcrawler` | 53 | 47 | 0 | 0 | 100.0% | 100.0% | 2 `null` sites with nothing at them (below) |
| `leswww/agentboard-ce` | 56 | 35 | 0 | 11 | 100.0% (35/35) | 76.1% (35/46) | W, V |
| `nz-m/SocialEcho` | 67 | 2 | 0 | 59 | 100.0% (2/2) | 3.3% (2/61) | R |
| `rakibutsho/SPIDER_NODE-uptime-tracker` | 26 | 22 | 0 | 0 | 100.0% | 100.0% | complete |
| `sahitya-chandra/DSA-Round-Robin` | 26 | 17 | 14 | 9 | 54.8% (17/31) | 65.4% (17/26) | P, S |
| `SamurAIGPT/ai-headshot-generator` | 15 | 7 | 0 | 0 | 100.0% | 100.0% | complete |
| `solid-logic-studios/bucketwise-planner` | 32 | 2 | 0 | 30 | 100.0% (2/2) | 6.3% (2/32) | T, U |
| `Vishwajit1610/Resonance` | 6 | 6 | 0 | 0 | 100.0% | 100.0% | complete |
| `wiseweb-works/mern-bookstore` | 10 | 10 | 0 | 0 | 100.0% | 100.0% | complete |
| `yigehaozi/relay-status-monitor` | 50 | 32 | 0 | 4 | 100.0% (32/32) | 88.9% (32/36) | W |

This note explains the misses. It changes no score and starts no fix. Batch 5 stays unseen until a fix is chosen with these misses in view; from then on it counts as seen, like batches 1–4 (ADR-0168). Cause letters continue after batch 4's (A–O), so the two notes can be cited side by side.

## Method

- After the scored run, analyzed each checkout in `eval/.repos/` at its pinned commit with the built `analyze()` (the scratch `eval/dist/b4-diag.mjs`), and listed the services, routes, unresolved nodes (reason, expression, detail), `http` edges with their sites, and warnings.
- Read the code at each missed site and at the helper, base, or router it goes through, and compared it with the analyzer's documented "not handled" lists and the ADRs.
- Reproduced P, Q, and T in a minimal repo (a scratch script under `eval/dist/`) to confirm the cause, not only the symptom.
- Counted each miss under exactly one cause; the FN column sums to 170 and the FP column to 20.

## Summary

Ranked by false negatives. "Visible as" says what the user sees today.

| # | Root cause | FN | FP | Repos | Visible as |
|---|---|---:|---:|---|---|
| R | Express routers created as `require("express").Router()` aren't detected, so their routes are missing | 59 | 0 | SocialEcho | `NO_MATCHING_ROUTE` at each site |
| S | A path-taking helper declared as a local `const` arrow inside another function (a test, a fixture, a component) isn't a wrapper | 54 | 0 | kortext (47), DSA-Round-Robin (7) | unresolved at the helper's own `fetch`, nothing at the callers |
| T | A `let url` later extended with a query (`url += \`?${qs}\``) reads as runtime-only | 27 | 0 | bucketwise-planner (26), chessu (1) | `DYNAMIC_URL` at each site |
| W | One condition picks both the URL and the method (`const url = x ? a : b; const method = x ? "PUT" : "POST"`) | 10 | 0 | agentboard-ce (6), relay-status-monitor (4) | `AMBIGUOUS` unresolved |
| X | The base comes from a React context (`const { backendUrl } = useContext(ShopContext)`) | 6 | 0 | ecommerce-app | `DYNAMIC_URL` at each site |
| V | A component fetching a path prop (`<DeleteButton endpoint={…}>`) isn't read as a helper | 5 | 0 | agentboard-ce | unresolved at the component's `fetch` |
| U | An env base not named like an API base (`VITE_AUTH_BASE \|\| "/auth"`) | 4 | 0 | bucketwise-planner | `NO_MATCHING_ROUTE` naming the env var |
| P | A URL chosen by a ternary on a hook's parameter (`slug ? \`…/getmatch/${slug}\` : "…/active"`) makes the hook a wrapper, and every caller gets both branches | 2 | 14 | DSA-Round-Robin | both routes at each of the hook's 7 callers |
| Y | A literal with a trailing space (`` `/api/forum/post/comment ` ``), which the URL parser trims | 2 | 0 | DevCircle | `NO_MATCHING_ROUTE` |
| Q | A helper whose parameter fills only the port (`fetch(\`http://127.0.0.1:${port}/api/health\`)`) is a wrapper, so its request moves to the callers | 1 | 6 | kortext | the right route at the callers' sites |
| | **All** | **170** | **20** | | |

The three largest causes (R, S, T: 140 of the 170 misses) are each one form that reaches every request of one repo, or of its tests. Both precision causes (P, Q) come from where wrapper inlining places a request, not from matching: Q's six predictions name the right route at the wrong site, and P's name both branches of a ternary at sites where the argument settles which one.

## Precision (the 20 FP)

- **P, a ternary on a hook's parameter (14 FP, 2 FN).** `apps/web/hooks/useSocket.ts` is `useSocket(userId, slug?, onMatchFound?)`. Inside a `useEffect`, `joinExistingMatch` builds `const url = slug ? \`${API_BASE_URL}/api/match/getmatch/${slug}\` : \`${API_BASE_URL}/api/match/active\`` and calls `fetch(url, { credentials: "include" })`. The label is at that `fetch` (line 67), with one label per alternative (ADR-0041), since `slug` fills a path parameter, not the path (EVALUATION.md §1). The analyzer makes `useSocket` a wrapper and places the request at its 7 callers, each with both routes, `heuristic`: 7 × 2 = 14 FP, and the 2 labels at line 67 get nothing. In a minimal repo the same happens without the hook or the nested closure (`function join(slug) { const url = slug ? \`/api/x/${slug}\` : "/api/y"; return fetch(url) }`), although neither branch's `slug` hole is leading by `leadingHoles` (ADR-0164), so the ternary's condition is what makes the wrapper. Five of the seven callers pass only `userId`, so `slug` is `undefined` there and only `/api/match/active` can be sent; inlining keeps both branches anyway. A fix would decide whether a condition reading a parameter makes a wrapper at all, and, where it does, prune a branch the argument settles (a missing argument is falsy).
- **Q, a port parameter (6 FP, 1 FN).** `server/daemon.ts`'s `serverUp(port)` sends `fetch(\`http://127.0.0.1:${port}/api/health\`)`, and `waitForServer(port)` calls it. `leadingHoles` counts a parameter "in the host or port" as leading by design (M5A.3j), so `serverUp` is a wrapper, `waitForServer` a wrapper over it (M5C.7f), and the request lands at their callers in `server/index.ts` (2) and `test/daemon.test.ts` (4), with the right route. EVALUATION.md §1 labels a request whose path is fixed in the helper at the helper's own call (the port isn't the path), so the label at `daemon.ts:8` is missed and the 6 caller sites are unlabeled FPs. The analyzer's rule and the label rule disagree on an origin-only parameter; a fix would align them (a host or port parameter keeps the request at its own call when the path after it is fixed), which also changes `wrappers.ts`'s header and ADR-0164.

## Calling side

- **S, local helpers (54 FN).** kortext's tests declare `const request = (suffix, body, method = 'POST') => fetch(\`http://127.0.0.1:${port}/api/projects/${p.id}/${suffix}\`, { method, … })` inside a fixture function and return it (`release.test.ts`, 20 labels), or as a `const` inside the test body (`update.test.ts`'s `request(path, body, method)`, 22, including an 11-path literal loop; `engines.test.ts`'s `put(path, body)`, 5). DSA-Round-Robin's `Sidebar.tsx` and `QuickAddFriendModal.tsx` declare `const safeFetch = async (url, options) => fetch(url, options)` inside the component (7). ADR-0032 makes only symbols wrappers ("nested closures and functions that aren't symbols are not wrappers"), so each helper's own `fetch` is unresolved (`NO_MATCHING_ROUTE` on `http://127.0.0.1:{}/api/projects/{}/{}`, or `DYNAMIC_URL`) and its callers get nothing. A general form would treat a `const` arrow or function bound in a function body as a wrapper for calls in the same scope; the fixture's returned helper (destructured by each test, `const { request } = await fixture(t)`) is a further step.
- **T, a `let` URL extended with a query (27 FN).** bucketwise-planner's `request(path, method, body, searchParams, retry)` starts `let url = \`${API_BASE}${path}\`` and appends `url += \`?${queryString}\`` when there are search params; chessu's `fetchArchivedGame` starts `let url = \`${API_URL}/v1/games?\`` and appends `id=…` or `userid=…` in either branch. The normalizer reads a reassigned `let` as runtime-only (reproduced with a one-line `if (q) url += \`?q=${q}\``), so the wrapper's 26 callers and chessu's site are `DYNAMIC_URL`. An append after a `?` (or of text starting with `?`) can't change the path, so the route is still known; ADR-0041 already labels a `let` reassigned in a branch as alternatives.
- **W, URL and method from one condition (10 FN).** agentboard-ce's three forms and relay-status-monitor's two dialogs do `const url = isEditing ? \`/api/x/${id}\` : "/api/x"; const method = isEditing ? "PUT" : "POST"; fetch(url, { method })`. The labels pair each URL with its method (ADR-0209's M5C.8b3 note). The analyzer reads both URLs but not a method from a ternary, and since M5C.7a an unread method whose routes differ only by method is one `AMBIGUOUS` unresolved node instead of an edge per method. That trade was chosen for precision; reading a ternary method, and pairing it with the URL when both test the same condition, would match all 10 with no guess.
- **X, a base from React context (6 FN).** ecommerce-app's `ShopContext.jsx` reads `const backendUrl = import.meta.env.VITE_BACKEND_URL` and passes it in the provider's `value`; four pages do `const { backendUrl } = useContext(ShopContext)` and `axios.post(backendUrl + "/api/user/login", …)`. The 10 TPs are `ShopContext.jsx`'s own 4 requests and the admin app's 6 (it imports an exported `backendUrl` const); the 6 in pages are `DYNAMIC_URL`. Following a context value from `useContext(C)` to `<C.Provider value={{ … }}>` (or `createContext`'s default) is a React contract like `useCallback`'s, but needs the provider's value read across files.
- **V, a component as a helper (5 FN).** agentboard-ce's list pages render `<DeleteButton endpoint={\`/api/agents/${agent.id}\`} …/>`, and `DeleteButton` sends `fetch(endpoint, { method: "DELETE" })`. Labels sit at each element (EVALUATION.md §1, M5C.8b3); the analyzer has no notion of a prop as a parameter, so the element sites get nothing and the component's `fetch` is unresolved.
- **U, an env base not named like an API base (4 FN).** bucketwise-planner's `AUTH_BASE = import.meta.env.VITE_AUTH_BASE || '/auth'` serves `requestAuth(path)` and the refresh call. ADR-0165 matches an env base only when its name looks like an API base, and `VITE_AUTH_BASE` doesn't, so these stay `NO_MATCHING_ROUTE` naming it. By design today; the literal fallback (`'/auth'`, the server's own mount) is the only value the repo gives.
- **Y, a trailing space (2 FN).** DevCircle's `axios.post(\`/api/forum/post/comment \`, payload)` (and a `patch`) carry a space at the end of the literal. The WHATWG URL parser strips leading and trailing spaces, so the request reaches `/api/forum/post/comment` (ADR-0209's M5C.8b4 note); the normalizer keeps the space, and no route matches.

## Receiving side

- **R, `require("express").Router()` (59 FN).** All five of SocialEcho's route files start `const router = require("express").Router();`, and `server/app.js` mounts them (`app.use("/posts", postRoutes)` after `const postRoutes = require("./routes/post.route")`). The Express detector recognizes `express.Router()` on an `express` binding (and `const Router = require("express").Router`, as `express.test.ts` checks), but not the call on the `require` itself, so it finds only the app's own 2 routes; every client request (`API.get(\`/posts/${id}\`)` on `REACT_APP_API_URL`, read from `.env.example`) is `NO_MATCHING_ROUTE`. The 2 TPs are the client's requests to those 2 app routes (`GET /search`, `GET /server-status`). This is CommonJS's most compact spelling of Express's documented `express.Router()`, so it's likely common outside this repo.

## What the batch shows

- **Precision:** both causes are request placement by wrapper inlining (ADR-0032, ADR-0164), on two sites of two repos: one hook (P: 14 FP) and one helper chain (Q: 6 FP). Every FP is `heuristic`; `exact` is 163 TP, 0 FP. No FP is a wrong route match: Q names the right route at the callers, and P names the two routes the code can send, at callers whose arguments settle which.
- **Recall:** after M5C.7, batch 4's causes don't recur except as relatives (S is D's local-scope sibling, X is a base passed through a React API like H, U is ADR-0165 by design). The new largest causes are one detector form (R: 59), local helpers (S: 54), and a reassigned `let` (T: 27).
- **By design:** U (an env name not shaped like an API base, ADR-0165) and W's `AMBIGUOUS` (M5C.7a's precision trade) are deliberate today; both stay visible as unresolved, never guessed.

## Other observations (not scored)

- **Abstentions.** The 58 abstentions at `null` labels were external hosts (16), `DYNAMIC_URL` (30), `NO_MATCHING_ROUTE` (10), and `WRAPPER_DEPTH` (2). The 2 `null` sites with nothing at them are nextcrawler's `fetch(value)` in `lib/testlib.js:75` and `lib/transform.js:108`, whose `value` is a parameter, so their requests moved to the transformers' callers (runtime values there). That keeps nextcrawler, with 47 of 47 and no FP, from counting as mapped completely.
- **Confidence.** 163 TP are `exact` and 127 `heuristic` (no `pattern`); all 20 FPs are `heuristic`.
