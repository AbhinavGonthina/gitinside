# Held-out batch 6: why 234 labels are missed and none is wrong (M9.2c)

Diagnosis of held-out batch 6's first and only blind measurement, the final eval of the launch analyzer, in [`2026-11-10-0.3.0.md` at `1bb2549`](https://github.com/AbhinavGonthina/gitinside/blob/1bb2549/eval/results/2026-11-10-0.3.0.md#held-out-batch-6-unseen) (GitInside `b3c93aa`, analyzer 0.3.0; labels committed in M9.2b1–b4, before the analyzer first ran on any of the 16 repos). Precision is 100.0% (521 of 521 predicted routes), above the 95% floor. Recall is 69.0% (521 of 755 real targets), below the 80% target. 6 of 16 repos are mapped completely (37.5%). All 35 `null` labels got no route (23 abstentions, 12 sites with no prediction).

| Repo | Labels | TP | FP | FN | Precision | Recall | Causes |
|---|---:|---:|---:|---:|---:|---:|---|
| `2Revol2/DreamingEnglish` | 17 | 13 | 0 | 3 | 100.0% (13/13) | 81.3% (13/16) | AH |
| `abjt14/agamjeet` | 5 | 5 | 0 | 0 | 100.0% | 100.0% | complete |
| `digitalocean/sea-notes-saas-starter-kit` | 26 | 13 | 0 | 12 | 100.0% (13/13) | 52.0% (13/25) | AD |
| `Gribadan/RentTools.io` | 268 | 233 | 0 | 17 | 100.0% (233/233) | 93.2% (233/250) | U, W; 8 `null` sites with nothing at them (below) |
| `issam-seghir/discord-clone` | 21 | 8 | 0 | 13 | 100.0% (8/8) | 38.1% (8/21) | AF, AE |
| `ivanrods/balancefy` | 25 | 25 | 0 | 0 | 100.0% | 100.0% | complete |
| `kalczugag/Employee-Leave-Management` | 28 | 7 | 0 | 21 | 100.0% (7/7) | 25.0% (7/28) | AC |
| `KEX-03/taskflow` | 34 | 11 | 0 | 23 | 100.0% (11/11) | 32.4% (11/34) | AB |
| `Misyuk-T/worklog-hub` | 65 | 62 | 0 | 0 | 100.0% | 100.0% | 3 `null` sites with nothing at them (below) |
| `MohammedMusharraf11/Alumni-Connect` | 13 | 13 | 0 | 0 | 100.0% | 100.0% | complete |
| `RicardoGEsteves/SpreadIt` | 12 | 11 | 0 | 0 | 100.0% | 100.0% | complete |
| `swarooppatilx/bit-by-query` | 13 | 11 | 0 | 0 | 100.0% | 100.0% | 1 `null` site with nothing at it (below) |
| `TheArcus02/Better-GPT` | 18 | 17 | 0 | 0 | 100.0% | 100.0% | complete |
| `Tushyent/TakeUForward` | 149 | 3 | 0 | 141 | 100.0% (3/3) | 2.1% (3/144) | AA |
| `vicharanashala/cp1` | 79 | 79 | 0 | 0 | 100.0% | 100.0% | complete |
| `vijethph/PlacementCell` | 17 | 10 | 0 | 4 | 100.0% (10/10) | 71.4% (10/14) | AG |

This note explains the misses. It changes no score, no label, and starts no fix. Cause letters continue after batch 5's (A–Y) as AA, AB, …; where a batch 5 cause recurs (U, W), its letter is reused, so the notes can be cited side by side.

## Method

- After the scored run (committed first, as `1bb2549`), analyzed each checkout in `eval/.repos/` at its pinned commit with the built `analyze()` (the scratch `eval/dist/m92c-diag.mjs`), and listed the services, routes, unresolved nodes (reason, expression, detail), `http` edges with their sites, and warnings.
- Read the code at each missed site and at the helper, base, or client it goes through, and compared it with the analyzer's documented "not handled" lists and the ADRs.
- Reproduced AA, AB, AC, AD, and AH in minimal repos (one Express server and one client file each, the scratch `eval/dist/m92c-repro.mjs`), each beside the nearest form that is read, to confirm the cause, not only the symptom.
- Counted each miss under exactly one cause; the FN column sums to 234. There is no FP.

## Summary

Ranked by false negatives. "Visible as" says what the user sees today.

| # | Root cause | FN | Repos | Visible as |
|---|---|---:|---|---|
| AA | A base passed through `.replace(/\/+$/, "")` (trailing-slash trim) isn't read, even on a literal | 141 | TakeUForward | `DYNAMIC_URL` at each site ("the axios baseURL starts with a value only known at runtime") |
| AB | A module-level `let baseUrl;` assigned once later, inside a `listen(0, () => …)` callback in a test's `before` hook | 23 | taskflow | `DYNAMIC_URL` at each site |
| AC | A base spelled `window.location.protocol + "//" + window.location.host + "/api"` (the page's origin, as `window.location.origin` is read) | 21 | Employee-Leave-Management | `DYNAMIC_URL` at each RTK Query endpoint |
| U | An env base not named like an API base (`BLOG_PUBLISH_ORIGIN \|\| "https://renttools.io"`), its fallback the app's public host | 13 | RentTools.io | `NO_MATCHING_ROUTE` naming the env var |
| AD | A base held in a constructor parameter property with a default (`constructor(private baseURL = "/api/notes")`) | 12 | sea-notes-saas-starter-kit | `DYNAMIC_URL`, or nothing at the site |
| AF | A path handed down as a component prop or through a zustand store to the component or hook that sends it | 8 | discord-clone | nothing at the page's element; `DYNAMIC_URL` at the sender |
| AE | A URL built by `qs.stringifyUrl({ url, query })` (the query-string package) | 5 | discord-clone | `DYNAMIC_URL` at each site |
| W | The method chosen by a condition (`method: x ? "DELETE" : "POST"`, or the whole `init` from a ternary) | 4 | RentTools.io | `AMBIGUOUS` unresolved |
| AG | A helper whose parameter fills the path after a literal segment (`fetch(\`${routePrefix}/${url}\`)`, prefix `…/v1`) | 4 | PlacementCell | `NO_MATCHING_ROUTE` at the helper's own `fetch`, nothing at the callers |
| AH | The caller's method lost through a two-helper chain whose inner init is `{ ...options, headers: { … } }` | 3 | DreamingEnglish | `AMBIGUOUS` unresolved |
| | **All** | **234** | | |

AA alone is 60% of the misses (141 of 234): one form at the root of one repo's only axios instance. The four largest causes (AA, AB, AC, AD: 197) are each one way of writing a base that the normalizer doesn't evaluate, so every request on that base is missed at once. Nothing is guessed: every miss is shown as unresolved with a reason, or (17) as no request at the labeled site because it was placed at, or left at, another call.

## Precision (no FP)

Every one of the 521 predicted routes is right, `exact` 312 and `heuristic` 209 (no `pattern`). Batch 5's two precision causes (P, Q, fixed in M5C.10a–b) don't recur, and none of the M9.1 fixes (env fallback paths, catch-all exclusion, SDK bases, class and object members) made a wrong edge here.

## Calling side

- **AA, a trailing-slash trim (141 FN).** TakeUForward's `client/src/api/axiosClient.js` builds `const baseURL = (isDeployed && rawUrl && rawUrl.includes('.onrender.com') ? '/api' : (rawUrl || '/api')).replace(/\/+$/, '')` and `axios.create({ baseURL, withCredentials: true })`; every page imports that one instance. In a minimal repo, the same ternary without `.replace` is read (`GET /api/items` matched), but `.replace(/\/+$/, "")` on it, on `(import.meta.env.VITE_API_URL || "/api")`, or even on the literal `"/api"` makes the base `DYNAMIC_URL`. A trim of trailing slashes can't change a path's segments, so the value before it is the route. maxun's MCP worker writes the same trim (`this.apiUrl`, M9.1a7's note), so the form isn't one repo's. Two of the 141 are `handleAlumniAction(requestId, action)`'s callers (`ModerationQueue.jsx:298`, `:308`): the request is drawn at the helper's own call (line 62), and whether M5C.10d's local-helper rule would place it at the callers can't be seen while the base is unread.
- **AB, a `let` assigned in a callback (23 FN).** taskflow's `server/test/tasks.test.js` declares `let baseUrl;` at the top and sets it once in `before`: `server = app.listen(0, () => { baseUrl = \`http://localhost:${server.address().port}\`; resolve(); })`. Each test then calls `fetch(\`${baseUrl}/api/v1/tasks…\`)`. The normalizer reads a `const` origin on `server.address().port` (its `cors.test.js` matches, and so does the minimal repo's `const baseUrl`), but a `let` with no initializer and one later write inside a nested callback is runtime-only. ADR-0166 reads a `let` extended in place, not one first written in another function.
- **AC, the page's origin spelled out (21 FN).** Employee-Leave-Management's four RTK Query APIs use `fetchBaseQuery({ baseUrl: window.location.protocol + "//" + window.location.host + "/api" })`. `window.location.origin + "/api/items"` is read as same-origin (PlacementCell's 10 TPs go through it), but the protocol-plus-host spelling isn't. Its 7 TPs are the thunks' plain axios calls on `/api/...`. The unresolved detail also says "the axios baseURL", though this base is `fetchBaseQuery`'s `baseUrl` (below).
- **U, an env base not named like an API base (13 FN).** RentTools.io's `scripts/publish-blog-api.mjs` sets `const base = process.env.BLOG_PUBLISH_ORIGIN || 'https://renttools.io'` and sends every request through `api(endpoint, method)` → `fetch(base + endpoint, …)`. ADR-0165 reads an env base only when its name looks like an API base, and the fallback is a public host: the labels follow it into the repo only because the repo's committed nginx and systemd files serve that host with this app (ADR-0209), which the analyzer doesn't read. By design today, as in batch 5; the detail names the env var.
- **AD, a parameter property's default (12 FN).** sea-notes-saas-starter-kit's `NotesApiClient`, `StripeClient`, and `UsersClient` each declare `constructor(private baseURL = '/api/notes')` (or `/api/billing`, `/api`) and fetch `\`${this.baseURL}/…\``; the app constructs them with no argument. M9.1a7a reads a `this.<field>` whose one write is its initializer or a constructor statement (the minimal repo's `private baseURL = "/api/items"` matches), but a parameter property is written from the parameter, whose default applies only when a caller passes nothing. Reading it would need every `new` of the class to be checked for that argument. 3 of the 12 (`getNote`, `updateNote`, `deleteNote`, `\`${this.baseURL}/${id}\``) have nothing at the site: the method is a wrapper over `id`, so the request moved to its callers, unresolved there.
- **AF, paths as props and store values (8 FN).** discord-clone's channel and conversation pages render `<ChatMessages apiUrl="/api/messages" socketUrl="/api/socket/messages" …/>` and `<ChatInput apiUrl="/api/socket/messages" …/>`. The path then reaches `useChatQuery`'s `fetch(url)`, `ChatItem`'s `axios.patch(url)`, and, through the zustand modal store (`onOpen("deleteMessage", { apiUrl: \`${socketUrl}/${id}\` })`), `DeleteMessageModal`'s and `MessageFileModal`'s requests. The labels sit at the pages' elements (EVALUATION.md §1); the analyzer has no notion of a prop as a parameter (batch 5's V) or of a store value, so the elements get nothing and each sender is `DYNAMIC_URL`. All eight also build their URL with `qs.stringifyUrl` (AE), so reading props alone wouldn't match them.
- **AE, `qs.stringifyUrl` (5 FN).** discord-clone's channel and member modals build `const url = qs.stringifyUrl({ url: \`/api/members/${memberId}\`, query: { serverId } })` and send `axios.patch(url, …)`. The `url` property is a literal or template the normalizer reads elsewhere; `stringifyUrl` only appends the query, so the path is the `url` property's. The analyzer doesn't know the package, so each URL is `DYNAMIC_URL`.
- **W, a method chosen by a condition (4 FN).** RentTools.io's admin panel sends `fetch(\`/api/admin/users/${user.id}/suspend\`, { method: isSuspended ? "DELETE" : "POST" })`, and its comments widget picks the whole init, `const init = action === "delete" ? { method: "DELETE" } : { method: "PATCH", … }`, then `fetch(\`/api/blog-comments/${id}\`, init)`. Each site has two labels, one per method (ADR-0041). As in batch 5, a method the analyzer can't read and whose routes differ only by method is one `AMBIGUOUS` node (M5C.7a's precision trade), so both labels are missed; reading a conditional method would match all four with no guess. Batch 5's W also chose the URL from the same condition; here only the method varies.
- **AG, a path parameter after a literal segment (4 FN).** PlacementCell's `getData(url)` sends `fetch(\`${routePrefix}/${url}\`, …)` with `routePrefix = \`${window.location.origin}/v1\``, called as `getData("companies")`, `getData("videos")`, and so on. ADR-0164 makes a helper a wrapper only when a parameter is leading (it starts the path, or the whole URL), and a hole after the literal `/v1/` isn't, so the request stays at the helper's `fetch` as `NO_MATCHING_ROUTE` ("only a catch-all of every path matches /v1/{}"), and the four callers, where the labels sit, get nothing. EVALUATION.md §1 labels a wrapper whose caller supplies the path at that caller, so the analyzer's rule and the label rule disagree on a parameter that fills every segment after a fixed prefix, as they did on batch 5's Q.
- **AH, a method through a spread chain (3 FN).** DreamingEnglish's `'use server'` `serverApi(path, options)` calls `api(path, { ...options, headers: { ...options?.headers, cookie } })`, and `api` sends `fetch(\`${BASE_URL}${path}\`, options)`. The callers' method (`{ method: "POST" }`) or its absence (GET) doesn't survive the outer spread, so each site is `AMBIGUOUS` between the path's GET and POST routes. The minimal repo shows it: `api("/items", { method: "POST" })` matches, `serverApi("/items", { method: "POST" })` and `serverApi("/items")` are both `AMBIGUOUS`. M5C.7a and M5C.10e2 read a method through a rest element and a spread of conditional literals; a spread of the wrapper's own init parameter, one helper further out, isn't followed.

## Receiving side

No miss in batch 6 comes from route detection. Every labeled route exists in the analyzer's graph with its method and full path: Express routers mounted by `app.use` (TakeUForward's 27, taskflow's `/api/v1`), Next.js App Router and pages-router handlers with method guards (discord-clone, RentTools.io's ~95 `route.ts` files), and `withAuth(handler)` exports (sea-notes).

## What the batch shows

- **Precision:** 100.0% (521/521), `exact` and `heuristic` alike. This is the first blind batch above the 95% floor (batch 4: 94.4%, batch 5: 93.5%); both of batch 5's precision causes were fixed in M5C.10a–b and nothing new took their place.
- **Recall:** 69.0%, up from batch 5's blind 63.0% and batch 4's 51.1%, but still below 80%, and concentrated: one base form (AA) is 141 of the 234 misses, and with it fixed recall would be 87.7% (662 of 755) if nothing else changed. Without TakeUForward the batch is 518 of 611 (84.8%). The four base forms AA–AD (197) are each a value the normalizer doesn't evaluate; the calling-side relatives (AF of batch 5's V, W, AH of M5C.7a's spread rules) are smaller.
- **By design:** U (ADR-0165's env names and an unread deploy config) and W's `AMBIGUOUS` (M5C.7a's precision trade) are deliberate today; AG is ADR-0164's leading-hole rule. All three stay visible as unresolved, never guessed.

## Other observations (not scored)

- **Abstentions.** The 23 abstentions at `null` labels were external hosts (11), `DYNAMIC_URL` (11), and `NO_MATCHING_ROUTE` (1).
- **The 12 `null` sites with nothing at them.** 7 are RentTools.io's `EVisitorTestClient` requests, sent through `this.request(…)`, a constructor parameter that defaults to `fetch` (`private readonly request: FetchLike = fetch`), and 3 are worklog-hub's proxies calling `axiosClient({ method: req.method, url, … })`, where `axiosClient` is `createRouter`'s destructured option defaulting to `axios`. Both inject the HTTP client for tests, the client-side relative of AD, and the analyzer doesn't collect a call on such a parameter as a request at all, so these 10 requests (all to hosts outside the repo) are absent from the graph rather than shown unresolved. 1 is RentTools.io's `checkFeed(url)` in `app/api/calendar/health/route.ts:27`: the request moved to its two callers (lines 82–83, `DYNAMIC_URL`), where the outermost-caller rule would have put the `null` label too; the label was left at the `fetch` in M9.2b3, a labeling slip that changes no score (RentTools.io isn't mapped completely either way) and is left as committed, since the batch is scored once. 1 is bit-by-query's `client/src/auth.js`, which imports `../apiClient`, a file the repo doesn't have (the instance is `client/src/apiClient.js`), so the receiver is unknown and nothing is drawn; its `POST /api/status` has no route either.
- **Wording.** For an RTK Query base the unresolved detail says "the axios baseURL starts with a value only known at runtime" (Employee-Leave-Management's 21). The reason is right; the client's name in it isn't.
- **Confidence.** 312 TP are `exact` and 209 `heuristic` (no `pattern`).
