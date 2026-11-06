# M6 review: Graph diff + incremental analysis

**Status: draft (M6.11a, 2026-11-04).** The review's findings are planned as M6.11b–j; M6.11k re-runs the checks, fills in the outcomes, and tags `m6`. · **Range:** M6 commits from `8f353e3` (M6.1) to `3ee3ad3` (M6.10), interleaved with M5A, M5B, and M5C (#13, #15, #18) · **Checked at:** `3ee3ad3`

## What was built

M6 gives GitInside its two "over time" abilities: comparing two versions of a repo's graph and naming what broke, and re-analyzing a commit without redoing the services it didn't change. The diff is what the PR bot (M8) will post; the cache is what keeps the worker's re-analyses cheap.

| Piece | Where | What it does |
|---|---|---|
| Graph diff | `packages/diff` (ADR-0084, ADR-0085) | `diffGraphs(base, head)`: nodes and edges added, removed, modified (a per-kind fingerprint changed), or updated (only source positions moved), in canonical order; IDs are qualified names, so most records match by ID for free |
| Renames and moves | `rename.ts` (ADR-0086) | Files by moved hash, then shingle similarity ≥ 0.6 and folder votes; modules by their files; symbols following their file (body ≥ 0.8); unresolved nodes by their call site; a pair is taken only when both ends are the sole candidate in their tier |
| Broken connections | `broken.ts` (ADR-0087, ADR-0088) | An edge whose target head removed while a caller still asks for it, found by re-resolving the base edge in head: `TARGET_REMOVED`, `ROUTE_CHANGED` (routes, relative imports, Prisma models), `PARAMETERS_ADDED` (call sites with fewer arguments than head's required parameters), `FIELD_REMOVED` (Prisma fields a call uses) |
| Properties | `properties.test.ts` | fast-check: `diff(g, g)` is empty, `applyDiff(base, diff(base, head))` is head, add/remove symmetry, order independence; a guard that the generator reaches renames and all four broken reasons |
| CLI + Mermaid | `cli.ts`, `mermaid.ts` (ADR-0089) | `gitinside diff <base> <head>` over graph files, folders, or git refs (`--repo`), as JSON or a Mermaid summary (service-level, escaped labels) |
| Incremental analysis | `packages/analyzer` (ADR-0090, ADR-0098, ADR-0172–0181) | Every stage split into per-service facts and a global composition; each service's `ServiceFacts` cached on disk (`openDiskCache`: versioned keys, atomic writes, LRU cap) with the inputs it observed (content hash or absent, incl. other services' files); clean services reused, dirty ones collected, programs built only when a dirty service needs them; warm output == cold output byte for byte |
| Worker cache | `apps/worker/src/factcache.ts` (ADR-0178) | 64 MiB of Cloud Run's in-memory `/tmp`, counted in 4 KiB pages; `public/` and `installations/<id>/` folders; the sandboxed child may touch only its job's folder |
| Diff mode | `packages/viewer` (ADR-0182–0186), `apps/web` (ADR-0189) | One overlay graph holding both versions, laid out once; added green, changed amber, removed red and ghosted, broken connections dashed red and pulsing (still marked under reduced motion); Base / Head / Overlay without moving a box; per-version counts and labels; a changes list that flies to each change; on the website `?base=<sha>` compares with that commit's published analysis, never GitHub or a job |
| Walkthrough | `docs/walkthroughs/diff.md` | Every function of the diff in data-flow order, with the `diff-broken` pair traced to its six broken connections |

## Results (exactly as measured)

- **Tests (local at `3ee3ad3`, uncached):** 4,099 passed, 4 skipped: analyzer 1,227, viewer 1,094, web 650, worker 627 (+1 skipped), db 142 (+3 skipped), diff 122, eval 109, bench 95, schema 33.
  - The first parallel run (`npx turbo run test --force`) didn't get to any assertion in analyzer and viewer: esbuild's Go runtime crashed and tinypool couldn't spawn workers (the machine's memory, with two review subagents running).
  - Re-run one package at a time (`--concurrency=1 --continue`, 0 cached): all green except one worker test, `storage.test.ts` "stops when a listing hands back the token it was given", which got a connection error from its fake S3 server on the second request. That's M5 code, not M6. The file alone passed (57/57), and so did the whole worker suite alone (627/627).
- **Coverage (CI run 41946664116 on `3ee3ad3`):**
  - Analyzer: 97.63% lines, 91.03% branches (target 85%). M6's files: `cache.ts` 97.07% / 95.23%, `incremental.ts` 100% / 89.77%, `facts.ts` 100% / 88.88%, `inputs.ts` 100% / 97.02%.
  - Diff: 99.01% / 93.61% (target 85%): `broken.ts` 98.77% / 95.05%, `diff.ts` 100% / 97.95%, `rename.ts` 98.15% / 91.89%.
  - Every other package is at or above 94.62% lines (target 70%): viewer 99.29% (its overlay model `model/diff.ts` 100% / 94.73%), web 98.16%, worker 95.6% (`factcache.ts` 96.77%), db 99.14%, eval 99.65%, bench 100%, schema 94.62%.
- **Incremental speedup** (laptop, cal.com at `0f19cc4`, 113 services; `bench/results/2026-11-02-incremental-calcom-m6.8c2.md` and `…-commits-m6.8c2.md`). Every warm graph was its cold pair's bytes.

  | Case | Cold | Warm | Speedup |
  |---|---:|---:|---:|
  | Nothing changed | 24.9 s | 4.4 s | 5.7× |
  | One leaf app edited | 35.6 s | 12.6 s | 2.8× |
  | `packages/lib` edited (88 services re-collected) | 35.7 s | 36.3 s | 0.98× |
  | 10 real consecutive commits, median per commit | 35.3 s | 36.1 s | 0.99× (0.96–5.27×) |

  Nine of the ten real commits touch `packages/lib`, which nearly every service imports, so they re-collect 88–90 services and run at parity. DESIGN.md's "≤ 10 s after a 10-file change" budget is **not met** and now says so (this review, C4).
- **Accuracy:** M6 changes no matching. Its analyzer commits were refactors with no output change (goldens and eval unchanged), plus M6.4b's new facts (parameter counts, Prisma field names), which re-recorded the report with the same scores.

## Key decisions and trade-offs

- **Identity is the qualified name** (GRAPH_SCHEMA.md): `symbol:<service>/<path>#<name>`. Most items match by ID with no algorithm at all, and the rename matcher only looks at the base-only and head-only leftovers. The price is that a move or rename changes the ID, so rename detection is essential rather than cosmetic.
- **Never guess a rename** (ADR-0086): a pair is taken only when both ends are the only candidate in their tier, and ambiguous ends are claimed so lower tiers can't pair them either. Two identical copies of a moved file stay a removal and two additions.
- **Broken means "a caller still asks for it"** (ADR-0087): the diff re-resolves the base edge's evidence in head (the unresolved node the analyzer left at the call site) instead of building a TypeScript program. A removed function whose callers were all removed too is a deletion, not a break.
- **Facts, then compose** (ADR-0098, ADR-0174): every detector was split so a service's facts depend only on its own files plus recorded inputs, and everything cross-service happens in a global step that always runs. That was ten refactor tasks (M6.7c–d3d2) with the goldens and the eval unchanged at each step.
- **Diff mode is one graph** (ADR-0182): the overlay holds both versions, so one layout serves Base, Head, and Overlay and nothing moves when switching.

## Hardest problem: warm must equal cold

A cache that is right most of the time is worse than none, because a stale graph looks just like a correct one. The rule was that a warm run's output must be byte-identical to a cold run's, for any edit. Three things made that hard.

1. **What a service's facts depend on isn't just its files.** A TypeScript program reads other services' files through imports and path aliases, probes for files that don't exist (`index.ts`, `.d.ts` siblings), and lists folders. M6.7b records every path the program host and the detectors read or probe, with a content hash or "absent", and a test checks the log covers every read. An entry is reused only when all of them verify.
2. **Some facts are repo-wide.** Whether a function is an HTTP wrapper, or whether an import is a router or queue library, depends on other services. Those facts are recomputed each run and compared with what the cached bundle assumed; if they differ, the service re-collects (M6.7e2).
3. **The fact format changes with the analyzer.** `KEY_FORMAT` is part of every key, so a bump turns old entries into misses. It's a manual step, and it was missed once (M5B.7e, fixed in `d123148`). The review asks for a guard test (C3 → M6.11f).

Every incremental test compares warm and cold bytes over fixture edits (edit, add, delete, cross-service import, tsconfig, moved checkout). Every benchmark run checks the same thing on cal.com, and so did this smoke test.

## What's still weak

- **Real commits don't speed up on a shared-library monorepo:** cal.com's real commits run at parity because one shared package reaches 88 services. The cache only skips unchanged services; re-collecting one is no cheaper. Finer-grained invalidation (per file within a service) wasn't attempted.
- **Broken-route detection drifted from the matcher** (C2, fixed in M6.11c): routes reached through example-env prefixes, dev proxies, or `basePath` were never flagged. A call whose text changed in the same commit and reaches its old route only through one of those forms still isn't.
- **Inline Express handlers' calls aren't drawn** (smoke S2, from M1, not M6): a route's trace stops at the route, and a PR that removes a function those handlers call flags nothing.
- **A rename plus an edit in one commit is a removal and an addition:** `creatArticle` → `createArticle` with about 15 lines added scores under the 0.8 body threshold (see the smoke test). This is by design (ADR-0086), but it's the common shape of a real rename.
- **Exports don't mark changes** (U1, fixed in M6.11e for Base and Head): the Overlay exports head, saying so, rather than an image of the changes.
- **Uninstall deletion of the worker cache reaches one instance** (C5): planned into M8.5 rather than fixed now.

## Fresh-eyes review

Two subagents with no prior context reviewed M6's commits read-only, split between the non-UI half (diff package, incremental cache, worker cache) and the UI half (viewer diff mode, website `?base=`). Neither found anything high-severity.

They confirmed the following:
- **Determinism:** `compareStrings` everywhere, no `localeCompare`; `Date.now` only in temp-file cleanup; no `Map` order leaking into output.
- **Diff integrity:** inputs canonicalized, output validated by `parseGraphDiff`, `applyDiff` checking its preconditions.
- **Properties:** all three SPEC properties tested.
- **Cache safety:** SHA-256 file names with the full key compared on read, atomic renames, corrupt entries treated as misses, the child's `--allow-fs-*` limited to its job folder.
- **`?base=` on the website:** reads only a published, public, done analysis of a 40-hex SHA, never GitHub or a job, and is tested.
- **XSS and escaping:** React text everywhere, Mermaid labels escaped.
- **Accessibility:** removed boxes are `inert`, and broken edges stay dashed and labeled under reduced motion.
- **README:** its incremental numbers match the reports.

Findings marked "confirmed" were traced in the code by the reviewer; "plausible" ones need a red test first.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| C1 | Medium (confirmed) | A target that was renamed or moved never counts as broken (`broken.ts` `gone`), even when a caller didn't follow: `util.ts` moves, one importer keeps `./util` (`UNKNOWN_SYMBOL` in head), and the diff shows a rename, a removed edge, and an unresolved node, but no break | Fixed in M6.11b: `TARGET_MOVED` ("… is now at …"), ADR-0087 amendment |
| C2 | Medium (confirmed) | `parseHttpLabel` re-resolves only `{env:…}` and loopback origins; the matcher also applies example-env prefixes, dev-proxy rewrites, and `basePath`/rewrites, so a removed route reached through them isn't flagged (ADR-0087 promised no drift) | Fixed in M6.11c: each matched `http` site records its `request` text, and head's unresolved call with that label is the same call (ADR-0087 C2 amendment); `brokenPaths.test.ts` runs all four forms through the analyzer |
| C3 | Medium (confirmed) | `KEY_FORMAT` bumps are manual, one was missed (M5B.7e), and no test catches it; a CLI `--cache` folder would serve stale facts | Fixed in M6.11f: `keyFormat.test.ts` hashes every fixture's stored entries against `FACTS_DIGEST` beside `KEY_FORMAT` and fails until both are updated (a facts-only mutation that left every golden green went red); ADR-0213 |
| C4 | Medium (confirmed) | DESIGN.md's "≤ 10 s incremental" budget had no status, though cal.com's real commits run at 0.96–1.01× | Fixed in this task: marked **Not met** with the numbers |
| C5 | Medium (plausible, M8.5) | `deleteInstallationCache` deletes on one Cloud Run instance; others keep the installation's facts until evicted, and per-installation folders can't honor one repo's removal | Planned into M8.5's task line |
| C6 | Low (plausible) | Rename-by-content is capped by pair count (250k), not bytes; ~500 large removed and added files in one PR could burn the job's time | Planned: M6.11i |
| C7 | Low (confirmed) | A broken entry's `to` is the base ID, so a `PARAMETERS_ADDED`/`FIELD_REMOVED` target that was also renamed is drawn twice in the Mermaid summary | Planned: M6.11i |
| C8 | Low (confirmed) | Temp files from a writer killed mid-write don't count toward the cap (cleaned after an hour), and `remove()` lowers counters even for a file already gone | Fixed in M6.11f: temporary files count toward the total at every listing (not evicted; stale ones deleted), and the cache lowers its count only by what it counted for a file (a corrupt entry another instance wrote no longer takes it to −1); ADR-0213 |
| C9 | Low (docs) | DESIGN §9's 25.2 MiB per cal.com analysis predates ADR-0180/0181 (now 1.9–4.1 MiB) | Fixed in this task: both figures given |
| U1 | Medium (confirmed) | Export (SVG, PNG, Mermaid) ignores the version shown: Head exports removed items as plain boxes, Base exports added ones | Fixed in M6.11e: files show the version on screen (`versionView`) at its commit; the Overlay exports head and the share menu says so ([menu](M6/export/menu-overlay-dark.png), [Head's file](M6/export/file-head-dark.png), [Base's file](M6/export/file-base-light.png)) |
| U2 | Low–medium (confirmed) | "Changes here" is empty for a selection inside a folded added/removed row, though its frame badge counts changes | Fixed in M6.11g1: the overlay records the row each folded node is folded into (`foldedInto`), and "Changes here" lists that row |
| U3 | Low (confirmed) | A linked `view=base\|head` whose `sel`/`trace` the version lacks falls back to Overlay silently, and Copy link still says the linked version | Fixed in M6.11h: the page decides the version before the explorer opens (`linkedVersion` in `lib/compare.ts`), so the explorer gets the Overlay, the note says which version lacked what, and Copy link names the Overlay |
| U4 | Low (plausible) | Stop comparing unmounts the focused link; focus likely drops to `<body>` | Confirmed and fixed in M6.11h: focus waits on the diagram's spot and then goes to its focusable box, on the same page (base never analyzed: nothing reloads, which only the real-browser check caught) and from the latest page (a new diagram); `explorer.e2e.ts` checks it in Chromium |
| U5 | Low (confirmed) | A base graph that fails to load replaces the head diagram with an error card | Fixed in M6.11h: this commit stays on screen alone, the note says why nothing was compared, and its Try again loads the base alone ([dark](M6/base-failed/page-dark.png), [light](M6/base-failed/page-light.png)); a failure of this commit's graph still gets the card |
| U6 | Low (a11y, confirmed) | Zoomed out to `names`/`outline`, added and changed lines differ by color only (WCAG 1.4.1) | Fixed in M6.11g2: below full detail each added, changed, or removed line carries a glyph (+, ~, −) at its pill's point, kept 12 screen px; story "Diff, zoomed out" (40%) has Linux baselines, and dropping the glyph's position turns `diffMode.test.tsx` red |
| U7 | Low (test gap) | No test that `buildDiffOverlay` accepts every `diffGraphs` output; a legitimate pair it rejects shows an error card | Fixed in M6.11g1: `diff.properties.test.ts` runs 300 seeded pairs from `@gitinside/diff/testkit` (diff's own generators) through the overlay; none is rejected, and dropping base's parent frames turns it red |
| U8 | Design note | Stop comparing on the latest page goes to the commit's permalink, not back to check-on-view | Accepted: ADR-0189 chose "this commit's permalink" |

## Smoke test

The built CLI was run as a user would, on real public repos outside the eval (2026-11-04).

**1. `gothinkster/node-express-realworld-example-app`, `e40aeb9` → `5eeccf1`** (a commit that moves and renames files):
- `gitinside diff … --repo <clone>` exited 0, but the diff is empty.
- Both sides are an Nx standalone app: `nx.json`, a root `project.json` with source in `src/`, and an `e2e/project.json`. The `e2e/` project makes it a workspace, the root is never a service in a workspace (a documented limit in `workspace.ts`), and all 33 files under `src/` got `FILES_OUTSIDE_SERVICE`.
- It's visible as a warning, but the whole app goes unanalyzed (S1 → M6.11j).

**2. `gothinkster/node-express-prisma-v1-official-app`, `b3de3d5` (first commit) → `6ac99ea` (HEAD, 19 commits):**
- `gitinside diff b3de3d5 6ac99ea --repo <clone> --cache <dir>` exited 0, a 53.5 KB diff.
  - Nodes: 2 added, 2 removed, 15 modified, 16 updated.
  - Edges: 14 added, 5 removed, 6 modified, 18 updated.
  - 0 broken, no warnings.
- **Checked by hand against the commits:**
  - The `ArticleTags` model was removed (8f9c013 switched to an implicit many-to-many), along with its `stores` edge.
  - `Tag` and `Article` are modified (`fields`).
  - `getProfile` is modified (`requiredParams`, 47735e4).
  - `disconnectArticlesTags` was added along with its `writes` edge.
  - The Prisma `reads`/`writes` edges gained the fields the new code uses.
  - Nothing is broken, and that's correct: the one removed symbol had no remaining caller.
- **The rename `creatArticle` → `createArticle`** (0cb3c85, which also added a 15-line slug check) is a removal and an addition, both over the whole range and for that one commit, because its body scores below the 0.8 threshold. That's by design (see weaknesses).
- **Inline handlers' calls are missing:** all 21 routes are inline arrow handlers, and their calls into the services (`createArticle(…)`) have no edge and no unresolved node. The calls from those handlers aren't in the graph at all (S2 → M6.11d).
- **Cache and determinism:** the same diff with a warm cache and with no cache gave the same bytes (SHA-256 `69d35ad04d87…` all three times). `analyze` of HEAD with the cache: 108 nodes (21 routes, 39 symbols, 4 models), 105 edges, no warnings.
- **Mermaid summary of 0cb3c85:** one service, the `Article` model, an "Added reads, writes" line (green) and a "Removed writes" line (red, dashed).

## Interview questions

**1. How does the diff tell a deleted function from a broken one?**
By asking whether anyone still calls it. When base had an edge to a target that head removed, the diff looks at head for evidence that the caller still asks for it: the analyzer leaves an unresolved node at every call it can't resolve, recording what the call was (a symbol name, a URL, a relative path). If head has such a node where base had the edge, the caller is still asking, so it's broken. If the caller went too, it's a deletion. No TypeScript program is needed. *Follow-up:* "What does that miss?" A caller left behind by a rename or move (C1), and routes reached through rewrites the diff doesn't replay (C2).

**2. Why is rename detection so conservative?**
A wrong rename is worse than none. It hides a removal and an addition behind one "renamed" line, and it can hide a broken connection. So a pair needs both ends to be the only candidate in their tier, and the similarity thresholds were set from measurement (a 20% edit still scores ≥ 0.6 in 92–96% of samples; unrelated files do in 0.04%). *Follow-up:* "Where does that cost you?" A rename plus an edit in one commit, like the smoke test's `creatArticle` → `createArticle`, shows as a removal and an addition.

**3. How do you know the incremental cache never changes the output?**
Three ways. Each cached entry stores every input its service's analysis read or probed (a hash, or "absent") and is reused only if all of them still match. Repo-wide facts are recomputed each run and compared. And every test and benchmark compares warm bytes with cold bytes. *Follow-up:* "What's the weak spot?" `KEY_FORMAT`: if the meaning of the facts changes and nobody bumps it, old entries look valid. It was missed once; M6.11f adds a test that fails until it's bumped.

**4. Your cache makes an unchanged repo 5.7× faster but real commits 0.99×. Was it worth it?**
For the worker, yes: check-on-view re-analyzes on every new commit, and many repos' commits touch one leaf app (2.8×) or no code at all (5.27× for a locale-only commit). On a monorepo where nearly every commit touches a shared package, it's parity, and the review now marks the 10-second budget as not met rather than implying it. *Follow-up:* "What would it take?" Invalidation finer than a service, so editing `packages/lib/constants.ts` re-collects only the files that read that constant.

**5. Why lay out one overlay graph instead of diffing two layouts?**
Two separate layouts move boxes when you switch versions, so the eye loses what changed, and SPEC asks for a stable layout. One graph holding both versions is laid out once; Base and Head fade the other version's items in place. The costs are counts that must be computed per version, labels that differ per version, and exports that must pick a version (U1).

Quiz yourself: open Claude Code and say 'quiz me on M6'.
