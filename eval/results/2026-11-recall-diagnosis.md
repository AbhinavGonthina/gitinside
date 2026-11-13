# Cross-service recall: why 110 labels are missed (M5A.1)

Diagnosis of the false negatives in [`2026-10-31-0.1.0.md`](2026-10-31-0.1.0.md) (precision 96.6%, recall 20.3%: 28 of 138 real targets; 110 false negatives, 103 labels with nothing predicted at their site). The newest report, [`2026-11-01-0.1.0.md`](2026-11-01-0.1.0.md), has the same numbers; nothing in the analyzer changed between them.

This document explains the misses; it changes no score. The fixes are M5A.3a–j in `PROGRESS.md`, one per root cause, largest first. Each fix must handle a general pattern and come with its own fixture (#13).

## Method

- Analyzed each checkout in `eval/.repos/<owner>__<name>` at its pinned commit with the built `analyze()` (GitInside `2290833`; the analyzer is unchanged since the report's `e5e7ef0`). A scratch script dumped every service, route node, unresolved node (reason + expression), `http`/`external_call` edge with its sites, and warning.
- Read every missed call site in the checkout and traced it by hand: the import chain to the HTTP client, how the URL and base are built, and the route it should reach. Then compared that with what the dump shows and with the code that decides it (`workspace.ts`, `http.ts`, `wrappers.ts`, `url.ts`, `match.ts`, `express.ts`).
- Each label is listed under **every** cause that blocks it. Many labels need two or more fixes before they turn into true positives, so the per-cause counts add up to more than 110. The "alone" column counts the labels that fixing that cause by itself would turn into true positives.

## Summary

| # | Root cause | Labels blocked | Fixed by this alone | Repos |
|---|---|---:|---:|---|
| R1 | Env base with an in-code fallback drops the fallback's path (`?? "http://localhost:4000/api/v1"`) | 87 | 4 | WealthWise 48, foodie 39 |
| R2 | Methods of an exported object literal aren't wrappers (`export const apiClient = { get(endpoint) { … } }`) | 44 | 0 | WealthWise 44 |
| R3 | URL held in a config-object parameter (`httpRequest(req)` → `axios(req)`) | 39 | 0 | foodie 39 |
| R4 | axios defaults assigned after creation (`axios.defaults.baseURL = …`) | 39 | 0 | foodie 39 |
| R5 | Routers loaded from a folder listing (`glob.sync(…).map(require).reduce((r, x) => r.use(x))`) | 39 | 0 | foodie 39 |
| R6 | Sibling apps with no workspace manifest are one service, so their tsconfig `paths` aliases don't resolve | 15 | 15 | wanderlust 15 |
| R7 | Env var name not recognized as an API base (`VITE_API_PATH`) | 7 | 2 | wanderlust 7 |
| R8 | URL alternatives held in a variable (a `const` ternary, a `let` reassigned in a branch) | 4 | 0 | wanderlust 4 |
| R9 | Site anchored at the method name, not the call's start (`axios⏎  .get(…)`) | 3 | 0 | wanderlust 3 |
| R10 | Wrapper detection too eager: a parameter that only fills a path hole or the query moves the request to the caller | 1 (+1 FP, +1 missed abstention) | 1 | taxonomy 1, WealthWise (abstention) |

**The 110 by repo:** WealthWise 48, foodie 39, wanderlust 22, taxonomy 1. conversa has none.

**What the target needs.** 80% recall is 111 of 138. Fixing everything except foodie (R1, R2, R6–R10) gives at most 28 + 48 + 22 + 1 = 99 (71.7%). **The target can't be reached without foodie**, and foodie needs four fixes together: R1 + R3 + R4 + R5. R5 is the one in doubt (see below). If it can't be done within "parsed, never executed", foodie stays unresolved and M5A.4 reports that rather than tuning around it.

## By repo

### hoangsonww/WealthWise-Finance-Tracker (48 FN, 45 missing)

Two `apps/web` patterns, both reading `BASE_URL`/`API_URL` = `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1"`. The API's routes are found correctly (`/api/v1/...` in `apps/api`).

- **4 direct `fetch` calls** (`forgot-password-client.tsx:114`, `:144`, `register-page-client.tsx:89`, `lib/auth.ts:28`): predicted `unresolved NO_MATCHING_ROUTE` with URL `{env:NEXT_PUBLIC_API_URL}/auth/login`. The normalizer reads `env ?? fallback` as just the env var (`url.ts`, "the env var is the deployed value"), so `/api/v1` is lost and `/auth/login` matches nothing. EVALUATION.md §1 has the labels follow the fallback. **R1 alone.**
- **44 hook calls through `apiClient`** (`hooks/use-*.ts`, `settings-page-client.tsx:229`, `:383`): nothing predicted at the site. `lib/api-client.ts` exports `apiClient = { async get(endpoint, params) {…}, async post(endpoint, body) {…}, patch, delete }`. Each method calls `fetch(\`${BASE_URL}${endpoint}\`)` (GET: `const url = new URL(\`${BASE_URL}${endpoint}\`)`, then `fetch(url.toString())`). Methods of an object literal aren't wrapper symbols (`wrappers.ts`, "object literals that aren't exported symbols"), so each method body becomes one `DYNAMIC_URL` request at `api-client.ts`, and the 44 callers get nothing. **R2 + R1.** For the 20 GET calls, also check that a `const` holding `new URL(…)` followed by `.toString()` (with `url.searchParams.set` in between) normalizes once inlined. `url.ts` handles `new URL(…).toString()` and const identifiers; this exact chain is unverified, so R2's fixture must include it.
- **Missed abstention** (not a FN): `apps/api/src/services/advisor.service.ts:249`, `fetch(\`${GEMINI_MODELS_ENDPOINT}?key=${apiKey}\`)` inside `fetchGeminiModels(apiKey, …)`. `apiKey` only fills the query string, but because the URL reads a parameter, the function counts as a wrapper and the request is moved to its caller (line 280, where it shows as an `external_call`). **R10.**

### jgudo/foodie (39 FN, 39 missing)

Root `package.json` has no `workspaces`, so `frontend/` and `server/` are one service with no tsconfig (`TSCONFIG_MISSING`). The 39 requests are all in `frontend/src/services/api.ts`: `httpRequest<T>({ method: 'POST', url: '/authenticate', data })`. Four things stand between them and their routes:

1. **R3:** `httpRequest` (`services/fetcher.ts`) is `(req: AxiosRequestConfig) => axios(req)`. The URL lives in a config parameter. `wrappers.ts` reads a method from a config parameter but not a URL ("a URL held entirely in a config parameter"), so the one site is `unresolved DYNAMIC_URL axios(req)` at `fetcher.ts:37`, and the 39 callers get nothing.
2. **R4:** the base is `axios.defaults.baseURL = \`${foodieUrl}/api/${foodieApiVersion}\``, assigned on the default instance after import. `http.ts` doesn't read `defaults` assignments, so the base is unknown and `/api/v1` is lost.
3. **R1:** `foodieUrl = process.env.REACT_APP_FOODIE_URL || 'http://localhost:9000'` and `foodieApiVersion = process.env.REACT_APP_FOODIE_API_VERSION || 'v1'`. Read as env vars, the second one is a hole in the middle (`/api/{}/authenticate`), and a hole never matches the literal `v1`. The first one's name isn't API-like either (R7). Its fallback, a loopback host, would be `heuristic` under R1.
4. **R5:** the server's routes are found, but as `/v1/authenticate`, not `/api/v1/authenticate` (10 `EXPRESS_UNMOUNTED_ROUTER` warnings). `app.ts` mounts `app.use('/api', routers)`, where `routes/createRouter.ts` builds `routers` from `glob.sync('**/*.ts', { cwd: __dirname }).map(f => require(\`./${f}\`)).filter(…).reduce((root, r) => root.use(r.default), Router())`. The set of routers is a folder listing, so the composition step never links them to the `/api` mount.

**Update (M5A.3e, ADR-0162):** R5 is handled at `heuristic`, and foodie's routers are now mounted on `createRouter`'s root router. A fifth cause this diagnosis missed (R5b) still blocks all 39: `app.ts` mounts that router on `this.app`, a class property declared without an initializer and assigned in the constructor, which the Express detector doesn't follow. That's M5A.3e1.

**R5 is the open question.** The folder's files are in the repo, so listing them is reading, not executing, and "every file in this folder that default-exports a Router is mounted here" is a general pattern (also `fs.readdirSync(__dirname).forEach(f => app.use(require('./' + f)))`). But the glob string here depends on an env check (`ts` vs `js`), and the `.filter` runs a prototype check. M5A.3e decides whether this pattern can be recognized at `heuristic` (literal folder, `require` of each listed file, `use` in a loop or reduce) or must stay unresolved. Either way it gets an ADR.

### krishnaacharyaa/wanderlust (22 FN, 18 missing)

Root `package.json` has no name and no `workspaces`; `frontend/` and `backend/` each have their own `package.json` and tsconfig. The whole repo is one service, `app`, with no tsconfig (`TSCONFIG_MISSING`). Backend routes are found with their full mounts (`/api/posts/...`).

**Update (M5A.3f, ADR-0163):** `frontend/` and `backend/` are now services with their own tsconfigs, so the 15 `axiosInstance` calls are collected, with the base `{env:VITE_API_PATH}` (R4 landed first), and wait on R7. The same change resolved conversa's `@/lib/api` imports and exposed R10 there (9 requests moved to 14 callers), so M5A.3j now comes right after M5A.3f.

**Update (M5A.3g, ADR-0165):** `VITE_API_PATH` is now an API-base name, and wanderlust is 17/22. What's left is as diagnosed: R8 (4 labels at `blog-feed.tsx:23` and `details-page.tsx:44`) and R9 (`blog-feed.tsx:35`, predicted at line 36, so it scores as 1 FP + 1 FN). Held-out online-ide's `SERVER_URL` is accepted too, and shows the same R9 split on 16 multi-line `axios⏎ .get(` calls.

**Update (M5A.3h, ADR-0166):** a ternary's branches and a `let`'s reaching values are now one request each. wanderlust is 19/22: `details-page.tsx:44` gives both DELETE routes; `blog-feed.tsx:23` now predicts both labeled routes, but at line 24, so it waits on R9 with `blog-feed.tsx:35`.

**Update (M5A.3i, ADR-0167):** `http` sites are now anchored at the call expression's start. wanderlust is 22/22, and the original five are at 138/138 with no false positives; held-out online-ide's one-line-off pairs are gone too (held-out 78/78).

- **15 calls on `axiosInstance`** (`useAuthData.ts:28`, `header-layout.tsx:24`, `admin-blogs.tsx:18`, `:26`, `admin-users.tsx:19`, `:28`, `details-page.tsx:77`, `form-blog.tsx:84`, `:89`, `:91`, `home-page.tsx:14`, `signin-page.tsx:31`, `:79`, `signup-page.tsx:31`, `:74`): nothing predicted. Every import is `import axiosInstance from '@/helpers/axios-instance'`, and `@/*` is defined only in `frontend/tsconfig.json`, which is never loaded. So the import is `UNKNOWN_SYMBOL`, the instance is never typed as axios, and the calls aren't collected. **R6.** Once the alias resolves, the URLs are root-relative (`/api/posts`), because `instance.defaults.baseURL = VITE_API_PATH` isn't read (R4), and they match the backend's routes. If R4 lands first, the base becomes `{env:VITE_API_PATH}`, and then these 15 also need R7.
- **3 plain `axios` calls with `import.meta.env.VITE_API_PATH + '/api/posts/…'`** (`blog-feed.tsx:35`, `details-page.tsx:60`, `edit-blog.tsx:20`): `unresolved NO_MATCHING_ROUTE`. The URL normalizes fine (`{env:VITE_API_PATH}/api/posts/{}`), but `match.ts` only accepts env bases named `*_API_URL` / `*_BASE_URL`, and `VITE_API_PATH` doesn't fit. **R7** (alone for 2; `blog-feed.tsx:35` also needs R9).
- **`blog-feed.tsx:23` ×2** (featured / by category): `axios⏎ .get(VITE_API_PATH + categoryEndpoint)`, where `const categoryEndpoint = cond ? '/api/posts/featured' : \`/api/posts/categories/${c}\``. A ternary whose branches differ becomes a hole (`url.ts`), so the URL is `DYNAMIC_URL`. **R8 + R7 + R9.**
- **`details-page.tsx:44` ×2** (own post / admin): `let url = \`/api/posts/${postId}\``, reassigned to `/api/posts/admin/${postId}` for admins. `let` isn't read (`url.ts`), so it's `DYNAMIC_URL`. **R8 + R7.**
- **R9, the site line:** for a call split across lines (`axios` on line 23, `.get(` on line 24), `http.ts` anchors the site at the method name (line 24), but EVALUATION.md §1 defines the call site as the start of the call expression (line 23). The three `blog-feed.tsx` labels can't match even once resolved. The labels follow the documented rule, so the analyzer changes (or the rule is amended in an ADR, never the labels to fit the output).

### shadcn-ui/taxonomy (1 FN, 1 FP)

- `components/post-operations.tsx:29`, `deletePost(postId)` → `fetch(\`/api/posts/${postId}\`, { method: "DELETE" })`. The route is fixed inside the helper; `postId` only fills the `:postId` hole. The analyzer treats the function as a wrapper and predicts the route at the caller (`:92:39`), which is both the FN at 29 and the `unlabeled-site` FP at 92. **R10.** EVALUATION.md §1: "a `fetch`/axios call whose URL is fixed there (even inside a helper like `getUsers()`) is labeled at that call"; only a helper that takes the *path* is labeled at its callers.

**Update (M5A.3j, ADR-0164):** fixed. Only a parameter in the URL's leading part makes a wrapper now; taxonomy 5/5, conversa back to 24/24 after M5A.3f, and WealthWise's Gemini call is a correct abstention.

### pankil-soni/conversa

No misses: 24/24 true positives, 2 correct abstentions.

## Order of fixes (M5A.3)

Largest first by labels blocked. R3–R5 tie at 39; they're ordered so each fix's fixture can be tested on its own:

| Task | Cause | Labels blocked | Notes |
|---|---|---:|---|
| M5A.3a | R1 env fallback | 87 | Keep the env var as the base, but carry the fallback's path prefix (`/api/v1`), use a literal fallback inside the URL (`'v1'`) in place of a hole, and let a loopback fallback host count as `heuristic` whatever the env name. ADR: this changes the stated "the env var is the deployed value" rule. Watch precision: a fallback prefix that differs from the deployed one would mislead. |
| M5A.3b | R2 object-literal methods | 44 | Methods and function-valued properties of an exported `const` object literal as wrappers; callers via `apiClient.get(…)`. Include the GET body's `const url = new URL(…)` + `url.toString()`. |
| M5A.3c | R3 config-object wrapper | 39 | A wrapper whose parameter is the axios config (`axios(req)`, `instance.request(req)`): read `url`/`method`/`baseURL` from the caller's object literal. |
| M5A.3d | R4 axios defaults | 39 | `x.defaults.baseURL = …` on the default export or an instance, when assigned once at module top level; otherwise unknown (never guessed). |
| M5A.3e | R5 folder-loaded routers | 39 | Decide (ADR) whether routers required from a listed folder and mounted in a loop/reduce can be composed at `heuristic`; else document the pattern as unhandled, and foodie stays at 0. |
| M5A.3f | R6 sibling apps without a workspace | 15 | Treat top-level folders with their own `package.json` as services when the root declares no workspaces (each with its own tsconfig); check the effect on every fixture and eval graph (service keys change). |
| M5A.3g | R7 env name | 7 | Widen `API_BASE_ENV` to API-ish names (`*_API_PATH`, `*_API_HOST`, `*_API`, `*_SERVER_URL`…) from a documented list; measure FPs on all five repos. |
| M5A.3h | R8 URL alternatives | 4 | A request may have several URL patterns: ternary branches (direct or through a `const`) and a `let` whose every assignment before the call is readable; one edge per alternative (ADR-0041 labels). |
| M5A.3i | R9 site anchor | 3 | Anchor `http` sites at the call expression's start, as EVALUATION.md §1 defines; goldens move. |
| M5A.3j | R10 eager wrappers | 2 + 1 abstention | Only a parameter that reaches the URL's leading part (base or first path segment) makes a function a wrapper; a parameter filling a later hole or the query stays a hole at the inner site. |

**Upper bound** if every fix lands and adds no false positive: 138/138. Without R5: 99/138 (71.7%). Held-out repos (M5A.2) are scored separately and never used to choose among these fixes.
