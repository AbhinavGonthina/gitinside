# M5A review: Cross-service recall

**Tag:** `m5a` (after the review fixes M5A.5b–f and the re-check M5A.5g) · **Range:** `9c7b385..m5a`, M5A commits only (M5A.1–M5A.5g; M5.17 and M5.18 work is interleaved in the same range and reviewed in M5) · **Date:** 2026-11-01, outcomes 2026-11-02

## What was built

M3's eval found the analyzer rarely wrong but mostly silent: precision 96.6%, recall 20.3% on the original five repos, with WealthWise, foodie, and wanderlust at 0%. M5A (Abhinav, #13) diagnosed every miss, fixed each cause as a general pattern, and measured the result on repos the fixes were never chosen from.

| Piece | Where | What it does |
|---|---|---|
| Diagnosis | `eval/results/2026-11-recall-diagnosis.md` | Every one of the 110 misses traced by hand to ten root causes, R1–R10, with counts per repo and "fixed by this alone" |
| R1 env fallbacks | `url.ts`, `match.ts` (ADR-0158) | `env ?? "http://localhost:4000/api/v1"` keeps the fallback's path and loopback host |
| R2 object clients | `symbols.ts` (ADR-0159) | Methods of an exported `const` object literal are symbols, so `apiClient.get(path)` can be a wrapper |
| R3 config wrappers | `http.ts`, `wrappers.ts` (ADR-0160) | `httpRequest(req)` ⇒ `axios(req)` reads `url`/`method`/`baseURL` from each caller's object |
| R4 `defaults.baseURL` | `http.ts` (ADR-0161) | A base written exactly once, at a module's top level, on one object |
| R5 folder-listed routers | `listings.ts`, `express.ts` (ADR-0162) | `glob.sync(…).map(require).reduce(…use…)` and `readdirSync(__dirname).forEach(…)` computed from the repo's own file list, never run; routes reached this way are `heuristic` |
| R5b constructor apps | `express.ts` | `this.app = express()` assigned once in the constructor is that app |
| R6 sibling services | `workspace.ts` (ADR-0163) | Without workspace config, top-level folders with their own `package.json` are services, each with its own tsconfig and `paths` |
| R7 env names | `match.ts` (ADR-0165) | A documented list of API-base endings (`*_API_PATH`, `*_SERVER_URL`, …) |
| R8 URL alternatives | `url.ts` `alternatives`, new `lets.ts` (ADR-0166) | A ternary or a `let`'s reaching values gives one request per value, at most 8 |
| R9 call-site anchor | `http.ts`, `wrappers.ts` (ADR-0167) | A request's site is the call expression's start, as EVALUATION.md defines |
| R10 wrapper rule | `url.ts` `leadingHoles` (ADR-0164) | Only a parameter in the URL's leading part makes a function a wrapper |
| Held-out batches | `eval/src/format.ts`, `report.ts` (ADR-0168) | `heldOut: <batch>`, each batch declared seen or unseen and scored apart from the headline |
| `upsertRepo` race | `packages/db/src/analyses.ts` (M5A.3d1) | One retry on a unique violation, found on CI's real Postgres |

Nine new fixtures with goldens: `env-fallback`, `object-client`, `config-wrapper`, `axios-defaults`, `express-folder-routers`, `express-class-app`, `sibling-apps`, `fixed-url-helpers`, `url-alternatives`, plus anchoring changes in five existing goldens.

## Results (exactly as measured)

- **Tests (M5A.5g re-check at `7c1c3e1`, local, `npx turbo run test --force`, 0 cached, 15/15 tasks):** 3,484 passed, 2 skipped: analyzer 875 (851 at M5A.5a; the review fixes added 24), viewer 1,007, web 597, worker 574 (+1 skipped), db 140 (+1 skipped), diff 122, eval 89, bench 47, schema 33. CI on `7c1c3e1` (run 41395908840) green on all four jobs (deploy skipped, as before #3).
- **Analyzer coverage (CI, `7c1c3e1`; local `coverage` times out one analyzer test on this machine):** 97.62% lines, 90.96% branches (target 85%; 97.45% / 90.73% at M5A.5a). The new files: `listings.ts` 100%, `glob.ts` 100% (M5A.5b), `url.ts` 99.22%, `workspace.ts` 99.68%, `http.ts` 98.99%, `match.ts` 98.66%, `express.ts` 97.48%, `wrappers.ts` 94.21%, `lets.ts` 93.78% (86.41% before M5A.5e's own test file; still the weakest).
- **Accuracy** ([final report](../../eval/results/2026-11-02-0.1.0.md), reproduced byte for byte by `pnpm eval --check` at `7c1c3e1`; pending owner review #1). The review fixes changed no count: every one of M5A.5b–f left the eval at TP 138, FP 0, FN 0 on the original five and the batches as below.

  | Set | Before M5A | After M5A |
  |---|---|---|
  | Original five | 96.6% precision, 20.3% recall (28/138) | **100.0% (138/138), 100.0% (138/138)** |
  | Held-out batch 1 (3 repos, now *seen*) | 75.4% (43/57), 55.1% (43/78), first scored before any fix ([at `1cdf2ec`](https://github.com/AbhinavGonthina/gitinside/blob/1cdf2ec/eval/results/2026-11-01-0.1.0.md#held-out-repos)) | 100.0% (78/78), 100.0% (78/78) |
  | Held-out batch 2 (2 repos, *unseen*, scored once) | n/a | **45.8% (11/24), 35.5% (11/31)** ([blind run at `eee9e37`](https://github.com/AbhinavGonthina/gitinside/blob/eee9e37/eval/results/2026-11-01-0.1.0.md#held-out-batch-2-unseen); unchanged since) |

  On the original five, 133 of 138 links are `heuristic` and 5 `exact`: they cross services through an env-named base, a root-relative path, or a folder listing, and the confidence says so. All six `null` labels are correct abstentions.
- **Batch 2's misses** ([diagnosis](../../eval/results/2026-11-batch2-diagnosis.md)): `next-connect`'s `handler.get(…)` registrations read as one `ALL` route (13 FN + 13 FP: right file and path, wrong method) and SWR-invoked fetchers (7 FN). Neither was fixed in M5A: fixing them now would make batch 2 seen too.

## Key decisions and trade-offs

- **Diagnose everything before fixing anything** (M5A.1). Each label is listed under every cause that blocks it, with a "fixed by this alone" count, which showed early that 80% recall was unreachable without foodie, and foodie needed four fixes together (R1 + R3 + R4 + R5).
- **"Exactly one write in a known place"** is how mutable state gets read: `defaults.baseURL`, a constructor-assigned app, a `let`'s reaching values. Anything else (a second write, a write in a function, `+=`, `var`) is unknown, shown as unresolved.
- **Names stand in for values the repo doesn't hold, only at `heuristic`** and only when a route's path aligns: env-base names by a documented list (ADR-0165), a loopback fallback (ADR-0158). Env values are never read.
- **The analyzer moved to the documented rules, never the labels to the analyzer:** R9 (call site at the call's start) was an EVALUATION.md rule from M3.
- **Seen vs unseen held-out sets** (ADR-0168). The first held-out three were read while fixing, so their 100% only says the fixes carried over to repos already looked at. A fresh batch was labeled and committed before the analyzer first ran on it, then scored once and quoted as measured: 35.5% recall.

## Hardest problem: R5, routers from a folder listing, without running anything

foodie builds its API router with `glob.sync("**/*.ts", { cwd: __dirname }).map((f) => require(\`./${f}\`)).filter(…).reduce((root, r) => root.use(r.default), Router())`. Every one of its 39 labels needed it, and the rule "untrusted repos are parsed, never executed" seemed to forbid it. The answer (ADR-0162) was that a folder listing is a *read*: the analyzer already holds the service's file list (and records it as an observed input for the incremental cache), so `readdirSync`/`glob.sync` can be computed from it, `.map(require)` resolves each listed file the way an `import` does, and `.reduce(…use…)` / `.forEach` / `for…of` mount what each element names. What can't be evaluated statically, the `.filter` callback, is skipped rather than interpreted, so a listing can mount a router the code would skip; that's why such routes are `heuristic`. Even then foodie stayed at 0: its root router was mounted on `this.app`, a class property assigned in the constructor, which the diagnosis had missed (R5b, M5A.3e1). The fresh-eyes review later found that the glob → regex translation itself could backtrack on a hostile pattern (finding 1: 274 s for one 32-character file name), so "computed from the file list" needed a linear matcher too; M5A.5b moved listings onto the workspace detector's dynamic-programming matcher, and the hostile cases now take milliseconds.

## What's still weak

- **Generalization is measured, and it's low:** batch 2's 35.5% recall shows the 100% on eight seen repos doesn't carry to unfamiliar shapes (`next-connect`, SWR). Both causes are documented with their general form; fixing them makes batch 2 seen, so a third batch would be needed for the next unseen number.
- **Small sample:** 10 hobby-size repos, 258 labels. Nothing about large production codebases.
- **Labels unreviewed:** #1 is still open; the eval re-runs when it closes.
- **Mostly `heuristic`:** 133 of 138 links rest on an assumption the confidence names (an env var points at this backend, a proxy forwards a root-relative path). That's honest but visually weaker.
- **Sibling services add a near-empty root box** whenever the root holds a config file (`eslint.config.js`, `scripts/*.mjs`): by design in ADR-0163, but noisy in the diagram (fresh-eyes finding 8).
- **Documented misreads** (ADR-0164, ADR-0166): `/posts/post-${id}` reads as a path, `"https://h/api/" + resource` as an ID; past 8 URL paths a site falls back to one hole; loops and `+=` stay unknown.
- **`defaults.baseURL` by imports is an approximation** (ADR-0161, amended in M5A.5d): an entry point that imports both a test setup and the app stays unmodeled, and a write the import graph can't see (a test runner's `setupFiles`) doesn't reach the files it really affects at test time. Production code is what the diagram shows, so this errs the right way.
- **The review fixes didn't move the eval** (no count changed in M5A.5b–f): they close guesses and a hang the eval repos never hit, so their only evidence is their regression tests.

## Fresh-eyes review

A subagent with no prior context reviewed the M5A part of `9c7b385..HEAD` (analyzer, schema, eval, fixtures, `upsertRepo`, README/EVALUATION.md) against SPEC.md, DESIGN.md, TESTING.md, SECURITY.md, and ADR-0158–0168, read-only. It found nothing high-severity, and **no repo-specific cases**: no repo names, file names, or eval identifiers in the analyzer; the env-name list and the FS/glob module lists are general, and ADR-0165 records where each name came from. It confirmed determinism (no `localeCompare`, `Date.now`, or randomness added; listings, globs, `listedRoutes`, and `let` values sorted), no reads outside the repo (listings come from the service's file list; `..` is refused), held-out batches scored apart, and README/EVALUATION.md numbers matching the report.

Finding 1 was confirmed by reading `globRegExp`, finding 2 was plausible; each fix began with a regression test that failed on the code as it was, so all eight code findings that were fixed (1–7, 9) proved real. No count in the eval changed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium (security) | `globRegExp` turns each `**` into `.*` with no limit, so a hostile glob in the repo's code (`**a**a…**b`) backtracks for hours on a long file name, during any listing loop. | Fixed, `539160f` (M5A.5b): red first (274 s for `**a`×10 + `b` over 32 characters); listings use the workspace detector's DP matcher, moved to `glob.ts` (caps 1,024 characters, 256 brace alternatives); milliseconds now |
| 2 | Medium | A factory returning a closure with its own path parameter (`createClient(base)` ⇒ `get: (path) => fetch(base + "/" + path)`) may read `GET /api/{}` at the factory's call and match `/api/:x`, a guess where `WRAPPER_DEPTH` belongs. | Fixed, `4841b6e` (M5A.5c): confirmed red (`GET /api/{}`); a call that binds none of a wrapper site's leading parameters is `WRAPPER_DEPTH` |
| 3 | Medium | One top-level `axios.defaults.baseURL` write anywhere in a service, including an e2e setup file, rebases every request in it, even in files that never load that module. | Fixed, `c81a5aa` (M5A.5d): a request sees only writes in files its file reaches through imports; ADR-0161 amended |
| 4 | Medium | A listing folder from a `const` in another file resolves `__dirname` and relative `require`s against the *using* file. | Fixed, `ecd6e4d` (M5A.5f): evaluated against the const's own file (red first with same-named decoy folders) |
| 5 | Low–medium (performance) | `letValues` re-walks the declaring function on every read, up to 10,000 reads per URL. | Fixed, `bc0f725` (M5A.5e): a declaration's writes found once (`WeakMap`); red first: 12 `refersTo` calls where 4 were enough |
| 6 | Low | A write through `(url as string) = …` (or `!`, `<T>`, `satisfies`) isn't seen, so the `let` keeps its old value. | Fixed, `bc0f725` (M5A.5e): such a write makes the `let` unknown |
| 7 | Low | A mid-URL env fallback that's an absolute URL replaces the hole (`{env:API_URL}/http:/localhost:5000/upload`). | Fixed, `ecd6e4d` (M5A.5f): a fallback replaces the hole only when it's a path piece |
| 8 | Low | Sibling-service mode makes the root a service for a lone root config file. | Kept: ADR-0163's rule; listed under weaknesses |
| 9 | Low (tests) | `lets.ts` has no test file; loop/`switch`/`try`/label writes, branch ends, `else if`, case-clause reads untested. | Fixed, `bc0f725` (M5A.5e): `lets.test.ts`; `lets.ts` coverage 86.41% ⇒ 93.78% on CI |
| 10 | Low (docs) | README's held-out "first run" numbers link to a report file that a later run overwrote (the numbers live at `1cdf2ec`); ADR-0168's reproduction note names an older commit than the committed report. | Fixed (M5A.5g): README and EVALUATION.md link the first runs at `1cdf2ec` / `eee9e37` and the after-M5A numbers to `2026-11-02-0.1.0.md`; ADR-0168's note names the M5A.5g reproduction |

## Smoke test

Built CLI on a real public repo outside the eval, as a user would run it: `adrianhajdin/project_mern_memories` at `9c2c416` (a React client and an Express server side by side, no workspace config, no tsconfig), `node packages/analyzer/dist/cli.js analyze <checkout> --owner adrianhajdin --name project_mern_memories --sha 9c2c416… --out …`.

- Exit 0, a 44.8 KB graph: 2 services (`mern-stack-client`, `mern-stack-api`, from M5A.3f's sibling rule), 11 modules, 19 files, 41 symbols, 6 routes; edges: 19 imports, 15 calls, 6 handles, 5 `http`. Two `TSCONFIG_MISSING` warnings (true: neither folder has one).
- **All 5 requests linked, checked by hand against the code:** `client/src/api/index.js` calls `axios.get/post/patch/delete` on `const url = 'http://localhost:5000/posts'` (plus `/${id}`, `/${id}/likePost`), and the server mounts `routes/posts.js` at `/posts`. Each edge goes to the right method and route (`GET /posts`, `POST /posts`, `PATCH /posts/:id`, `PATCH /posts/:id/likePost`, `DELETE /posts/:id`) at `heuristic` (a loopback host across services), anchored at each call's start. No wrong edge; the one route no client calls (`GET /posts/:id`) has no edge.
- A second run wrote a byte-identical file.

## Interview questions

**1. Your eval went from 20% to 100% recall. Why shouldn't anyone believe that number?**
Because the fixes were written while looking at those repos' misses, so 100% says the analyzer now handles *those* repos. That's why M5A added held-out batches and ADR-0168 relabeled the first batch as "seen" once its miss lists had been read. The honest generalization number is batch 2's, labeled and committed before the analyzer ever ran on it and scored once: 35.5% recall, 45.8% precision, from two patterns (`next-connect`, SWR fetchers) the fixes never targeted. *Follow-up:* "Why not fix those two and re-run?" Then batch 2 becomes seen too, and you'd need a batch 3 for the next unseen measurement.

**2. How do you mount routers from `glob.sync(…).map(require)` without running the repo's code?**
A folder listing is a read of the repo, and the analyzer already has the service's file list, so `readdirSync`/`glob.sync` are computed from it, and `require(f)` is resolved like an import. What would need interpretation (a `.filter` callback, a regex `replace`) is skipped, not run, so the result may include a router the code would filter out; those routes are only ever matched at `heuristic`. *Follow-up:* "What did the review find?" Turning the repo's glob into a regex could backtrack catastrophically on a hostile pattern (274 s on one file name), so M5A.5b replaced it with a dynamic-programming matcher whose time is bounded by pattern length × name length.

**3. When is a mutable value like `axios.defaults.baseURL` or a `let` safe to read statically?**
When there's exactly one write in a place whose execution is certain: a plain `=` statement at a module's top level for `defaults`, a constructor assignment for a class property, and for a `let`, the reaching definitions computed structurally through `if`/`else` and early exits. Anything less certain (a second write, one inside a function, `+=`, `var`, a read in a loop that also writes) makes the value unknown and the edge unresolved with a reason. *Follow-up:* the review's finding 3: "certain" also needs the requesting file to actually load the module that writes it.

**4. Why does a parameter's position in the URL decide whether a function is a wrapper?**
A helper like `get: (id) => fetch(\`${API}/conversation/${id}\`)` fixes its route and takes an ID; one like `request(path) => fetch(API + path)` takes the route. Nothing in the code says "path" vs "ID", but the hole's position does: leading (start, host, right after the base, the first segment) means the caller picks the route, so each call site is the request; a later segment or the query means the helper's own call site is the request. Treating every parameter as a path moved conversa's 9 requests to 14 callers and cost 14 false positives.

**5. Why are 133 of 138 links `heuristic`, and is that a problem?**
They cross service boundaries through something the repo can't prove: an env var named like an API base, a root-relative path that needs a proxy, a loopback fallback, or a folder-listed router. `exact` would claim certainty the code doesn't give. The cost is a weaker-looking diagram; the benefit is that a wrong deployment assumption shows up as an assumption, not a fact. *Follow-up:* "What's worse than a wrong heuristic edge?" A wrong `exact` one, which is what batch 2's `next-connect` misses are: right path, wrong method, at `exact`.

Quiz yourself: open Claude Code and say 'quiz me on M5A'.
