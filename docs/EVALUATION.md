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
  - `column` (the start of the call expression) is added only when one line holds several calls.
  - Call sites are sorted by file, line, column, and unique.
- **`method`** is the request's method (`GET`, `POST`, …), or `null` when the code computes it at runtime.
- **`target`** is the route the request really reaches, or `null` when it reaches none in the repo (external host, a service outside the repo, a URL that can't be known statically). `file` + `line` are where the route is registered (the `router.post(…)` call, or the Next.js handler export or page file). `route` is `"<METHOD> <path>"` in the analyzer's route spelling (GRAPH_SCHEMA.md): the full path after mounts, `:name` for dynamic segments and `*name` for catch-alls (Next.js `[id]` ⇒ `:id`, `[...slug]` ⇒ `*slug`), no trailing slash, no query; `ALL` when the handler accepts any method.
- **`labeler`** is `claude-draft` or `abhinav`; **`reviewedBy`** is the reviewer's GitHub login once the review is done.
- **`notes`** is optional free text: how the call was traced, or how a disagreement was resolved.

**Labeling method** (D10.3):
1. Labels are drafted by reading the code: find every outbound HTTP call site (grep `fetch(`, `axios`, client wrappers) and trace it by hand to its route.
   - **What is labeled:** every `fetch`/axios request written in the repo's TS/JS source, at the call site defined above. **Not labeled**, because no request expression is in the repo's code: requests made inside third-party libraries (MCP `SSEClientTransport`, NextAuth's `getSession`, SDK clients such as `@google/generative-ai`), socket.io/WebSocket clients, `<a href>` navigations, and scripts inline in `.html` files. These are fixed before scoring so they can't be tuned to the result.
   - **Env bases:** when a URL is built from an env var with an in-code fallback (`process.env.X ?? "http://localhost:4000/api/v1"`), the target follows the fallback, checked against the repo's `.env.example` and server port where they exist.
   - **Route order:** when several routes could match, the target is the one Express or Next.js would really dispatch to (registration order, literal before param), with a note.
2. The labeler must not look at analyzer output while labeling. Label files are committed before the first scoring run, so history shows they came first.
3. Abhinav reviews a random 20% of call sites. The sample is chosen by a seeded shuffle (seed = the date the review issue is opened) and listed in the issue.
4. Disagreements are resolved in the label file, with a `notes` entry, and summarized in the report.
5. Until review is complete, reports are headed **"Pending owner review"**.

**Scoring** (`pnpm eval`):
- **Matching:** a predicted `http` edge matches a label when the call site (file + line, plus column when the label has one) and target route (registering file + method + path, with parameter names ignored) agree.
- **True positive:** predicted target equals the labeled target.
- **False positive:** predicted target is wrong, or a route was predicted where the label says none (`target: null`).
- **False negative:** a labeled target that was never predicted (an unresolved prediction for a labeled real target counts here).
- **Unresolved predictions** for `target: null` labels count as correct abstentions and are reported separately, not inside precision.
- Precision and recall are reported **overall, per repo, and per confidence level** (exact / pattern / heuristic).

**Report:** `eval/results/<YYYY-MM-DD>-<analyzerVersion>.md`, committed, containing:
- Repos and SHAs, the analyzer version, and machine specs.
- A counts table with precision and recall.
- Every false positive and false negative with file:line.
- Limitations.

`pnpm eval` must reproduce a committed report byte-for-byte from pinned inputs.

**After M3:** any analyzer change states its eval delta in the commit body.

## 2. Benchmarks

**Analysis time (M1 baseline, M6 incremental):**
- **Repo:** one large public TS monorepo under 20k source files, pinned SHA, recorded in `bench/repos.json`.
- **Measured:** wall-clock time of `analyze` (median of 5 runs after 1 warm-up), peak RSS, and time per pipeline stage.
- **Incremental:** apply the diff of 10 consecutive real commits one at a time and measure re-analysis time vs. a full run. Report the median speedup.
- **Machines:** the Oracle Always Free VM (production) and Abhinav's dev machine. Each is labeled with CPU, RAM, OS, and Node version.

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
