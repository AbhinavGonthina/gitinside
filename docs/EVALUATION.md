# Evaluation: defensible numbers

GitInside's numbers must survive an interviewer asking "how did you measure that?" Rule zero: **report exactly what was measured, with method and limitations. Never inflate, round up, or cherry-pick.** Decisions: D3.4, D10.2, D10.3, ADR-0008.

## 1. Cross-service accuracy (M3)

**Question:** of the cross-service HTTP edges GitInside reports, how many are real (precision)? Of the real ones, how many does it find (recall)?

**Repos:** 5 public full-stack TypeScript repos with permissive licenses, within the 20k-file limit, covering different shapes:
- A Next.js app with its own API routes.
- A Next.js + Express (or similar) monorepo.
- A React SPA + Express backend in one repo.
- A repo using axios instances with `baseURL`.
- A repo with env-based API URLs.

Each is pinned by commit SHA in `eval/repos.json`: `{ "repos": [{ owner, name, url, sha, license, shape, why }] }`, sorted by `owner/name` (case-insensitive). `url` is `https://github.com/<owner>/<name>`; `license` is a permissive SPDX ID (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense); `shape` is one of `next-api-routes`, `next-plus-server-monorepo`, `spa-plus-express`, `axios-baseurl`, `env-api-urls` (the list above).

**The pinned set** (M3.2, 2026-10-28; one repo per shape, each pinned at its default-branch HEAD on that date):

| Shape | Repo | Source files |
|---|---|---|
| `next-api-routes` | `shadcn-ui/taxonomy` | ~131 |
| `next-plus-server-monorepo` | `hoangsonww/WealthWise-Finance-Tracker` | ~308 |
| `spa-plus-express` | `jgudo/foodie` | ~167 |
| `axios-baseurl` | `krishnaacharyaa/wanderlust` | ~109 |
| `env-api-urls` | `pankil-soni/conversa` | ~112 |

How they were chosen:
- **The analyzer was never run on any candidate.** Repos were picked by reading their code (licenses, package layout, how requests and routes are written), so the set can't be tuned to what GitInside already handles. The checkouts used for reading live in `eval/.repos/` (gitignored).
- **Server code must be in v1 scope** (Express or Next.js route handlers, TS or JS), so a route the analyzer can't see is a real miss, not a framework v1 never claimed. Rejected for this reason: `drodzewicz/Work-Flow` (routes are `routing-controllers` decorators). Also rejected: `shanhuiyang/TypeScript-MERN-Starter` (its client is mostly a React Native app) and `aelassas/bookcars` (about 40 MB on GitHub, many times the others; too large to label by hand in one pass).
- **Small enough to label every call site** by hand (about 100–300 source files), with routes the frontend really calls in the same repo.
- **Variety in how URLs are built**, not just in shape: a path-taking `fetch` wrapper (WealthWise), a wrapper over `axios(config)` with `axios.defaults.baseURL` (foodie), a base URL assigned after `axios.create()` (wanderlust), template literals over an env base with a fallback (conversa), and plain root-relative `fetch` (taxonomy).
- **Known limitation:** small and mid-size apps, mostly hobby or reference projects. Numbers from this set say nothing about large production monorepos (cal.com is used only for the performance benchmark).

**The held-out set** (M5A.2, #13): the recall work of M5A fixes the analyzer by studying the original five repos' misses, so their numbers can rise through fixes that only suit them. To check that fixes generalize, 2–3 more repos of the same stacks are added:
- **Same selection and labeling rules** as above. They are picked and labeled from their code alone, the labels are committed before the analyzer first runs on them, and their shapes come from the same list.
- **Marked with their batch number,** `"heldOut": 1`, in `eval/repos.json` (the field is absent for the original set). Each batch is declared once under `heldOutBatches` as `{ "batch": 1, "seen": "<why>" }`, or `"seen": null` while unseen; validation rejects a repo in an undeclared batch and a batch without repos (M5A.4a1).
- **Scored apart, batch by batch:** `pnpm eval` totals each batch separately, and the report gives each its own "Held-out batch N (seen|unseen)" section (repos, counts, by confidence, misses), saying why a seen batch is seen. Their counts never enter the headline precision and recall, the original set's totals, another batch's, or the M5A targets.
- **Never tuned against:** their misses are reported, never used to choose or shape an analyzer fix. A pattern they show only counts once the original set (or a new fixture written from the pattern's general form) shows it too.
- Their labels are not in the first owner review's sample (seed `2026-10-28`, drawn before they existed).
- **Seen sets** (ADR-0168): once a held-out repo's misses have been read while the analyzer was being fixed, it is "seen": still scored apart, but no longer evidence that fixes generalize. The first batch (the three below, `"heldOut": 1`) is seen since M5A.3g–3i, the second (`"heldOut": 2`) since M5B.1–M5B.2c fixed its misses (M5B.4). A generalization claim needs a fresh batch, labeled and committed before the analyzer first runs on it, quoted as first measured: batch 3 (`"heldOut": 3`, M5B.5–6) is that batch, unseen.

**M5A outcome** (2026-11-01, ADR-0168; same counts after the review fixes M5A.5b–f, and `pnpm eval --check` reproduces [the final report](../eval/results/2026-11-02-0.1.0.md)): original five precision 100.0% (138/138), recall 100.0% (138/138), from 96.6% / 20.3% at M3; held-out (seen) 100.0% (78/78) both, from 75.4% / 55.1% before any fix. 133 of the original 138 matches and 60 of the held-out 78 are `heuristic`.

**Held-out batch 2, first measurement** (M5A.4a3, 2026-11-01, [`eval/results/2026-11-01-0.1.0.md` at `eee9e37`](https://github.com/AbhinavGonthina/gitinside/blob/eee9e37/eval/results/2026-11-01-0.1.0.md#held-out-batch-2-unseen), unchanged in the final report, GitInside `915a661`; labels committed in that commit, before the analyzer first ran on either repo): precision 45.8% (11/24), recall 35.5% (11/31); twitter-clone 100.0% (11/11) / 61.1% (11/18), nextjs-prisma-boilerplate 0.0% (0/13) / 0.0% (0/13); both `null` labels abstained. The two causes (`next-connect` method registrations read as `ALL`, 13 FN + 13 FP; SWR calling the repo's fetcher, 7 FN) are in [the batch 2 diagnosis](../eval/results/2026-11-batch2-diagnosis.md) and are not fixed in M5A. Batch 2 stays unseen until a fix is chosen with its misses in view; from then on it counts as seen, like batch 1.

**Held-out batch 2 after M5B** (M5B.4, 2026-11-03, [`eval/results/2026-11-03-0.1.0.md`](../eval/results/2026-11-03-0.1.0.md#held-out-batch-2-seen)): precision 100.0% (31/31), recall 100.0% (31/31), all 31 `exact`; both `null` labels abstained. Recall rose to 77.4% with `next-connect` methods (M5B.1, ADR-0191), 96.8% with SWR's fetcher contract (M5B.2, ADR-0193), and 100.0% with negated `req.method` tests (M5B.2c, ADR-0195); M5B.2b and M5B.3 (ADR-0194, ADR-0196) changed no eval count. Each fix was written from the library's documented contract with its own fixture, but chosen with this batch's misses in view, so batch 2 is now seen. The original five and batch 1 are unchanged (138/138, 78/78). The generalization result after M5B is batch 3's blind run (M5B.5–6).

**Held-out batch 3, first and only blind measurement** (M5B.6, 2026-11-03, [`eval/results/2026-11-03-0.1.0.md`](../eval/results/2026-11-03-0.1.0.md#held-out-batch-3-unseen), GitInside `cc035be`; labels committed in `b8d86a1` and `cc035be`, before the analyzer first ran on either repo): precision 100.0% (45/45), recall 64.3% (45/70), below the 80% target; trendz 100.0% (45/45) both, all `heuristic`; Recipen n/a / 0.0% (0/25), no prediction at any of its 25 call sites; both `null` labels abstained. The one cause (C1: an RTK Query API whose `baseQuery` is a repo re-authorization wrapper around a `fetchBaseQuery` result, which ADR-0196 doesn't follow) is in [the batch 3 diagnosis](../eval/results/2026-11-batch3-diagnosis.md) and is not fixed in M5B.6. Batch 3 stays unseen until a fix is chosen with its misses in view.

The held-out candidates (M5A.2b, 2026-11-01; found with `gh search repos` for MIT-licensed React + Express apps, read but never analyzed):

| Candidate | How it calls its API | Source files | Status |
|---|---|---|---|
| `MananGandhi1810/online-ide` (`env-api-urls`) | Vite React + Express + Prisma; inline axios calls on `process.env.SERVER_URL`, substituted by Vite's `define` (no in-code fallback), template ternaries choosing between two routes, a router mounted at a parameterized path | ~80 | Pinned at its default-branch HEAD, labeled (24 labels at 22 call sites) |
| `shamahoque/mern-social` (`spa-plus-express`) | webpack React + Express in one package; per-feature `api-*.js` modules calling `fetch('/api/users/' + params.userId, …)` with root-relative, concatenated paths; routes declared with full paths in `router.route(path).get(…).put(…)` chains | ~43 | Pinned at its default-branch (`second-edition`) HEAD, labeled (18 labels at 18 call sites) |
| `RishiBakshii/mern-ecommerce` (`axios-baseurl`) | CRA React + Express side by side; `features/*/…Api.jsx` modules calling `axiosi.get(\`/cart/user/${id}\`)` on one `axios.create({ baseURL: process.env.REACT_APP_BASE_URL })` instance | ~123 | Pinned at its default-branch HEAD, labeled (39 labels at 39 call sites) |

The second held-out batch (M5A.4a2, 2026-11-01; found the same way, Next.js pages-router apps since none of the first eight uses the pages router, and URL styles none of them has; read but never analyzed before their labels were committed; scored once in M5A.4a3):

| Candidate | How it calls its API | Source files | Status |
|---|---|---|---|
| `harundogdu/twitter-clone` (`next-api-routes`) | Pages-router API routes (`pages/api/**`) picking methods with `req.method` guards; reads as SWR keys (`useSWR(\`/api/posts/${postId}\`, fetcher)`) handed to one `libs/fetcher.ts` (`axios.get(url)`) that no repo code calls; writes as inline axios calls, one URL chosen by a ternary held in a `const` | ~85 | Pinned at its default-branch HEAD, `"heldOut": 2`, labeled (19 labels at 18 call sites) |
| `nemanjam/nextjs-prisma-boilerplate` (`next-api-routes`) | Pages-router API routes built with `next-connect` (`nc().get(…).post(…)`) and a custom `server/index.ts`; react-query hooks calling one `axios.create()` instance (no `baseURL`) with paths from a `Routes.API.*` constants object (`` `${Routes.API.POSTS}${id}` ``) | ~200 (incl. tests) | Pinned at its default-branch HEAD, `"heldOut": 2`, labeled (14 labels at 14 call sites) |

The third held-out batch (M5B.5, 2026-11-03; found with `gh search repos` by topic (`rtk-query`, `tanstack-query` + `express`) for MIT-licensed apps, since none of the first ten sends its requests through a data-fetching library's own request or a `queryFn`; read but never analyzed, and labeled before the analyzer first runs on it; scored once, blind, in M5B.6):

| Candidate | How it calls its API | Source files | Status |
|---|---|---|---|
| `Avinash905/Recipen` (`env-api-urls`) | Vite React SPA + CommonJS Express + Mongoose side by side; every request is an RTK Query endpoint (`builder.query`/`builder.mutation` in `injectEndpoints` modules) sent through a custom `baseQueryWithReauth` around `fetchBaseQuery({ baseUrl: import.meta.env.VITE_SERVER_BASE_URL })`, no in-code fallback; `router.route(path).<method>(…)` chains under `/api/*` mounts | ~97 | Pinned at its default-branch HEAD, `"heldOut": 3`, labeled (26 labels at 26 call sites) |
| `nidhish-nayak/trendz` (`axios-baseurl`) | Vite React + TypeScript Express (Supabase, zod) side by side; TanStack Query hooks whose `queryFn`/`mutationFn` call one ``axios.create({ baseURL: `${config.serverUrl}/api` })`` instance, `config.serverUrl` a ternary between two env vars on `import.meta.env.MODE`; routers mounted at `/api/*` in `server/src/main.ts`; login, register, and logout on plain `axios.post` with the env base held in a `const`; the server calls a moderation API on an env URL | ~190 (incl. tests) | Pinned at its default-branch HEAD, `"heldOut": 3`, labeled (46 labels at 46 call sites) |

Rejected: `zayarlyn/jira-clone` (Express + Prisma, RTK Query) sends every request to its own deployed host written as a literal (`https://jira-clone.onrender.com/api/`). Whether that reaches a route in the repo or an external host is a labeling rule nothing above settles, and choosing it while reading one repo would shape the rule to that repo; `bradtraversy/proshop-v2` has no license.

**Ground truth format** (`eval/labels/<owner>__<repo>.json`):
```json
{
  "repo": "owner/name",
  "sha": "<40-char sha>",
  "labeler": "claude-draft",
  "reviewedBy": null,
  "scope": ["."],
  "edges": [
    {
      "callSite": { "file": "apps/web/app/blog/page.tsx", "line": 9 },
      "method": "GET",
      "target": null,
      "notes": "CMS on another host; correct answer is unresolved/external"
    },
    {
      "callSite": { "file": "apps/web/lib/api.ts", "line": 14 },
      "method": "POST",
      "target": { "file": "apps/api/src/routes/orders.ts", "line": 42, "route": "POST /api/orders" },
      "notes": "wrapper placeOrder()"
    }
  ]
}
```

Format rules (ADR-0040, enforced by `eval/src/format.ts`; `pnpm --filter @gitinside/eval validate` checks every committed file):
- **Paths** are repo-relative with forward slashes, no leading `./` or `/`, no `..`. Lines and columns are 1-based.
- **`scope`** lists the folders (or `.` for the whole repo) whose call sites are *all* labeled, sorted. Every `callSite` lies inside it. Predictions outside the scope are not scored; a route predicted at an in-scope call site with no label counts as a false positive (and is listed, so a missed label can be fixed with a note rather than hidden).
- **`callSite`** is where the URL's route becomes known, which is a property of the code, not of the analyzer:
  - a `fetch`/axios call whose URL is fixed there (even inside a helper like `getUsers()`) is labeled at that call;
  - a call through a helper that takes the path as a parameter is labeled at each call *of the helper* (the outermost caller that supplies the path, however many helper levels deep);
  - when a library calls the repo's helper with a key the repo hands it (SWR's `useSWR(key, fetcher)`, where `fetcher` is the repo's `axios.get(url)`), the outermost repo code supplying the path is that library call, so the label is there, and the helper's own request isn't labeled (M5A.4a2);
  - an RTK Query endpoint (`build.query({ query })` / `build.mutation(…)` under `createApi` or `injectEndpoints`) is a request whose path the repo fixes in `query`, and the library sends it through the API's `baseQuery`, so it is labeled at the endpoint's `build.query(…)` call, with `baseQuery`'s `baseUrl` joined (a string from `query` is `GET`). A base query's own call with a path fixed there (`baseQuery("/auth/refresh", …)` in a re-auth wrapper) is labeled there; its calls passing the endpoint's `args` on are not, like a helper whose caller supplies the path (M5B.5);
  - `column` (the start of the call expression) is added only when one line holds several calls.
  - A call site normally has one label. When its URL is one of several alternatives the code fixes statically (`cond ? "/a" : "/b"`, a `let url` reassigned in a branch), it gets **one label per route reached**, each with the same `callSite` (ADR-0041).
  - Labels are sorted by call site (file, line, column), then target (`null` first, then route, file, line), and unique.
  - Two labels at one call site can't name the same route as scoring compares it (registering file + method + path, parameter names and lines ignored), and a `null` label can't share a call site with a route label: it says the call reaches no route (ADR-0045).
- **`method`** is the request's method (`GET`, `POST`, …), or `null` when the code computes it at runtime.
- **`target`** is the route the request really reaches, or `null` when it reaches none in the repo (external host, a service outside the repo, a URL that can't be known statically). `file` + `line` are where the route is registered (the `router.post(…)` call, or the Next.js handler export or page file). `route` is `"<METHOD> <path>"` in the analyzer's route spelling (GRAPH_SCHEMA.md): the full path after mounts, `:name` for dynamic segments and `*name` for catch-alls (Next.js `[id]` ⇒ `:id`, `[...slug]` ⇒ `*slug`), no trailing slash, no query; `ALL` when the handler accepts any method. A pages-router API handler that admits only a listed set of methods (`405` otherwise, or a `switch` on `req.method`) is labeled with the request's method; one that runs its code for every method but a few it rejects (`if (req.method === "GET") throw`) is open, so `ALL` (M5A.4a2). A `next-connect` handler (`handler.get(…)`, `handler.post(…)`) admits the methods it registers, and its route line is that registration. A custom server's catch-all that only hands every request to Next's request handler (`server.all('*', (req, res) => handle(req, res))`) is a pass-through: the target is the Next.js route behind it. Static files (`express.static`, `public/`) are not routes, so a request for one is `null` (M5A.4a3).
- **`labeler`** is `claude-draft` or `abhinav`; **`reviewedBy`** is the reviewer's GitHub login once the review is done.
- **`notes`** is optional free text: how the call was traced, or how a disagreement was resolved.

**Labeling method** (D10.3):
1. Labels are drafted by reading the code: find every outbound HTTP call site (grep `fetch(`, `axios`, client wrappers) and trace it by hand to its route.
   - **What is labeled:** every `fetch`/axios request written in the repo's TS/JS source, at the call site defined above. **Not labeled**, because no request expression is in the repo's code: requests made inside third-party libraries (MCP `SSEClientTransport`, NextAuth's `getSession`, SDK clients such as `@google/generative-ai`, test clients such as supertest, and msw's mock handlers), socket.io/WebSocket clients, `<a href>` and `window.location` navigations, and scripts inline in `.html` files. These are fixed before scoring so they can't be tuned to the result.
   - **Env bases:** when a URL is built from an env var with an in-code fallback (`process.env.X ?? "http://localhost:4000/api/v1"`), the target follows the fallback, checked against the repo's `.env.example` and server port where they exist.
   - **Route order:** when several routes could match, the target is the one Express or Next.js would really dispatch to (registration order, literal before param), with a note.
2. The labeler must not look at analyzer output while labeling. Label files are committed before the first scoring run, so history shows they came first.
3. Abhinav reviews a random 20% of call sites. The sample is chosen by a seeded shuffle (seed = the date the review issue is opened) and listed in the issue.
   - **How it's drawn** (`eval/src/sample.ts`): per repo, the call sites (all labels at one site together) are shuffled with Fisher–Yates driven by mulberry32 seeded with the FNV-1a hash of `<date>/<owner>/<name>`, and the first ⌈20%⌉ are kept. Drawing per repo guarantees every label file is checked; the per-repo seed keeps each repo's sample independent of the others.
   - **Regenerate the list:** `pnpm --filter @gitinside/eval build`, then `pnpm --filter @gitinside/eval review-sample --seed <YYYY-MM-DD> [--out <file>]`. It prints a Markdown checklist with permalinks to each call site and labeled route at the pinned SHA.
   - **First review:** seed `2026-10-28`, 30 of 142 call sites (WealthWise 10, foodie 8, wanderlust 4, conversa 6, taxonomy 2).
   - The sample checks labels that exist; it can't find call sites the labeler missed. Unlabeled in-scope predictions show up as `unlabeled-site` false positives in every report instead.
4. Disagreements are resolved in the label file, with a `notes` entry, and summarized in the report.
5. Until review is complete, reports are headed **"Pending owner review"**.

**Scoring** (`pnpm eval`; implemented in `eval/src/score.ts`, ADR-0042):
- **Predictions:** every site of an `http` edge to a `route` node predicts that route at that site. Every site of an `http` edge to an `unresolved` node, or of an `external_call` edge to an `external` node, predicts "no route in the repo". Other edge kinds are not HTTP predictions. Predictions whose site is outside the label file's `scope` are not scored.
- **Matching:** each label is scored on its own, so a call site with two labeled routes needs both predicted for full recall. A route prediction matches a label when the call site (file + line, plus column when the label has one) and target route (registering file + method + path, with parameter names ignored) agree. Route lines are not compared (the analyzer anchors a route at its method call, the label at the registering statement). The same route predicted twice for one labeled call site counts once, whether it is right or wrong.
- **True positive:** a route prediction that matches a label's target.
- **False positive:** a route prediction that matches no label, listed with its kind: `wrong-route` (the site's label names another route), `route-for-null-label` (the label says `target: null`), or `unlabeled-site` (no label at that in-scope site).
- **False negative:** a labeled target that was never predicted, listed with what was predicted at the site instead (another route, an unresolved node and its reason, an external host, or nothing).
- **Abstentions:** a `target: null` label whose site has only non-route predictions (unresolved or external) is a correct abstention, reported separately, not inside precision.
- **Missing:** a label with no prediction of any kind at its site (a dropped call site) is listed separately too; a missing label with a real target is also a false negative.
- Precision = TP / (TP + FP); recall = TP / labels with a real target; an empty denominator is reported as "n/a", never as 0% or 100%.
- Precision and recall are reported **overall, per repo, and per confidence level** (exact / pattern / heuristic). Per-level recall is that level's true positives over *all* labels with a real target, so the three levels add up to the overall recall.

**Report:** `eval/results/<YYYY-MM-DD>-<analyzerVersion>.md`, committed, containing:
- Repos and SHAs, the analyzer version, and machine specs.
- A counts table with precision and recall.
- Every false positive and false negative with file:line.
- Limitations.

`pnpm eval` must reproduce a committed report byte-for-byte from pinned inputs (ADR-0043):
- `pnpm eval [--label "<machine>"]` checks out each pinned SHA under `eval/.repos/` (gitignored; read only, never installed or run), analyzes and scores it, and writes the report (`eval/src/run.ts`, rendered by `eval/src/report.ts`). Every run resets each checkout and deletes untracked and ignored files, and symlinks are checked out as plain files on every OS, so only the pinned tree is analyzed. A rerun on the same day with the same analyzer version replaces that day's report; git history keeps the old one.
- The report's **Run** section (date, GitInside commit, machine) is the only part that isn't a function of the pinned inputs. A run from a tree with uncommitted changes to the inputs is marked `+ uncommitted changes` and can't be checked, so commit the code first, then run the eval, then commit the report.
- `pnpm eval --check [report]` (default: the newest report by date, then version; a path is relative to where `pnpm` was run) reads that Run section back, refuses if the analyzer, schema, eval code, labels, or lockfile differ from the recorded commit, regenerates the report, and fails unless the bytes are identical. The **Eval** GitHub Actions workflow runs it on demand.

**After M3:** any analyzer change states its eval delta in the commit body.

## 2. Benchmarks

**Analysis time (M1 baseline, M6 incremental):**
- **Repo:** one large public TS monorepo under 20k source files, pinned SHA, recorded in `bench/repos.json`.
- **Measured:** wall-clock time of `analyze` (median of 5 runs after 1 warm-up), peak RSS, and time per pipeline stage.
- **Incremental:** apply the diff of 10 consecutive real commits one at a time and measure re-analysis time vs. a full run. Report the median speedup. `pnpm bench:incremental -- --commits` replays the 10 first-parent commits ending at the pinned SHA (history before it never changes); plain `pnpm bench:incremental` adds an unchanged rerun and synthetic one-line edits (a leaf app, a shared package). First results: [commits](../bench/results/2026-11-02-incremental-calcom-commits.md) (median 0.84×), [edits](../bench/results/2026-11-02-incremental-calcom.md). After M6.8b's storage cuts: [commits](../bench/results/2026-11-02-incremental-calcom-commits-m6.8b.md) (median 0.91×), [edits](../bench/results/2026-11-02-incremental-calcom-m6.8b.md). After M6.8c1 stored shared inputs once: [commits](../bench/results/2026-11-02-incremental-calcom-commits-m6.8c.md) (median 0.94×), [edits](../bench/results/2026-11-02-incremental-calcom-m6.8c.md). After M6.8c2 read each file once per run and stored inputs in parts (ADR-0181): [commits](../bench/results/2026-11-02-incremental-calcom-commits-m6.8c2.md) (median 0.99×), [edits](../bench/results/2026-11-02-incremental-calcom-m6.8c2.md).
- **Machines:** the Oracle Always Free VM (production) and Abhinav's dev machine. Each is labeled with CPU, RAM, OS, and Node version.

**Stress and the supported size (M5.16, #10):**
- **Repo:** microsoft/vscode at a pinned SHA (`bench/repos.json` `stress`), kept as a standing stress test: it is inside every limit before parsing (15,184 of 20,000 source files) but has 201 MiB of source, four times the 50 MB limit.
- **Measured:** `pnpm bench:stress` (no caps: tarball, unpacked size and entries against the extraction limits, wall clock, final heap, per-stage times) and `pnpm bench:capped <folders>` (the worker's own runner at production's caps, per folder: outcome, time, last step). Rerun both when the analyzer's memory use changes (M6.7) and on the production worker (M5.13), and recalibrate `MAX_SOURCE_MB` from the capped runs.
- **The supported size** (README, landing page, `LIMIT_*` copy; ADR-0138) is the inventory's two limits, "up to 20,000 source files and 50 MB of source code", with the largest finished runs quoted next to it: cal.com, 5,073 files / 18 MiB in 38 s, and VS Code's `src/vs/workbench/contrib`, 3,523 files / 59 MiB in 51 s, both on the dev laptop ([report](../bench/results/2026-10-31-capped-vscode.md)).

**Rendering (M4b):**
- A synthetic and a real graph at 500 / 1,000 / 2,000 visible nodes.
- Playwright drives pan and zoom for 10 s; fps comes from `requestAnimationFrame` deltas (median and p5).
- Target: ≥ 60fps median at 2,000 nodes.

**Output:** `bench/results/<YYYY-MM-DD>-<name>.md` with raw numbers (JSON alongside), committed.

## 3. PR backtesting (M7)

**Question:** on real merged PRs, how often would GitInside have flagged a broken cross-service connection, and were those real?

**Method:**
1. Pick about 8 public repos with separate frontend and backend code, pinned in `eval/backtest/repos.json` with a date window.
2. For every merged PR in the window: analyze the base commit and the merge commit (incrementally), run `diff`, and record broken edges.
3. **Follow-up:** within the next 30 days of commits, was the break fixed (target restored, or the call removed or changed)? Record the fixing commit.
4. **Classification:** for every flagged break, a human-readable judgment (true break / false positive / unclear) with a reason. Claude drafts; the report states who classified and what was reviewed by Abhinav.
5. **Report** (`eval/backtest/results/<date>.md`): PRs scanned, PRs flagged, breaks flagged, true/false/unclear counts, fixed-later counts with links, and limitations (e.g. a "fix" might be coincidental).

**Never claim** "caught N bugs" unless each is classified as a true break with evidence. Phrase claims exactly as measured, for example: "flagged 23 broken connections across 1,140 merged PRs; 17 were confirmed real, and 12 of those were fixed in a later commit."
