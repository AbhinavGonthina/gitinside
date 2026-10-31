# M4b review: Interactive explorer

**Tag:** `m4` · **Range:** `ff112af..m4` (M4b.0a–M4b.14b, the review in M4b.15a, its fixes in M4b.15b–h) · **Date:** 2026-10-31

> **Status: verified and tagged.** The full suite, E2E, visual tests, the render benchmark, and a real-repo smoke test are green. Two fresh-eyes reviewers found no high-severity issue. Their findings and the readability problem the smoke test showed were fixed in M4b.15b–g, the same way M5.14 split its review fixes from its verification (ADR-0079). M4b.15h re-ran every check on the fixed code and had a third reviewer check the fixes. That review found one more medium issue, fixed before the tag, and four lows, queued as M4b.16 (see "Re-check after the fixes").

## What was built

The whole explorer from docs/UX.md except diff mode, on the real analyzer graph, in the library and on the website.

| Piece | Where | What it does |
|---|---|---|
| Design gate fixes | `src/nodes`, `src/edges`, `src/mark.ts`, `src/motion.ts` | Content that fits its box, a shape per layer and card kind, a stronger current trace hop, the new mark, a motion pass with `usePresence` exits (ADR-0100–0104) |
| Graph model | `src/model/` | Hierarchy index, edges lifted to their visible ancestors, a service's routes and pages first, filters that hide a node with its inside (ADR-0105, ADR-0120) |
| Layout | `src/layout/` | One ELK run per view with sizes measured from content, in a Web Worker with an in-thread fallback, cached per expansion and filter state; cheaper settings above 200 boxes (ADR-0106, 0107, 0131) |
| Drill-down canvas | `src/explorer/DrillCanvas.tsx`, `transition.ts` | Expand in place: boxes glide, children grow from the opened node, closed ones fold back, edges fade in after; interruptible; instant under reduced motion; tile-snapped culling on big levels (ADR-0108, 0129) |
| Explorer | `src/explorer/Explorer.tsx` and friends | Breadcrumbs, minimap, pan/zoom/fit, zoom-dependent detail, inspector summaries from graph facts, Shiki code preview loaded from GitHub, computed trace with picker and player, Ctrl+K palette, filters popover, deep links, SVG/PNG/Mermaid export, a WAI-ARIA tree for keyboard and screen readers, first-visit hints, no-app and warnings states (ADR-0109, 0112–0113, 0115–0128) |
| Website | `apps/web/app/[owner]/[repo]` | The repo page on the explorer: layout worker under the CSP, URL kept in step, share menu, error card (ADR-0123, ADR-0128) |
| Render benchmark | `bench/render`, `bench/src/render.ts` | The production explorer in headless Chromium at 500 / 1,000 / 2,000 visible nodes, synthetic and cal.com (ADR-0130) |
| E2E + visual | `apps/web/e2e/`, `packages/viewer/visual/` | Production build on PGlite over the wire protocol, 18 E2E tests; website and Storybook screenshots against Linux baselines (ADR-0132, 0133) |

Decisions are ADR-0100 to ADR-0133 (ADR-0111 and ADR-0114 are M5's Cloud Run change).

## Screenshots

The committed Linux baselines (1280×800), copied here so this doc doesn't change when baselines do, plus two from the smoke test below.

| | Dark | Light |
|---|---|---|
| System level | ![](M4b/overview-dark.png) | ![](M4b/overview-light.png) |
| Drilled three levels deep | ![](M4b/drilled-deep-dark.png) | ![](M4b/drilled-deep-light.png) |
| Zoomed out (names and aggregated edges only) | ![](M4b/zoomed-out-dark.png) | ![](M4b/zoomed-out-light.png) |
| Trace mode | ![](M4b/tracing-dark.png) | ![](M4b/tracing-light.png) |
| Trace picker | ![](M4b/trace-picker-dark.png) | ![](M4b/trace-picker-light.png) |
| Command palette | ![](M4b/search-dark.png) | ![](M4b/search-light.png) |
| Filters | ![](M4b/filters-dark.png) | ![](M4b/filters-light.png) |
| Share and export | ![](M4b/share-dark.png) | ![](M4b/share-light.png) |
| Warnings | ![](M4b/warnings-dark.png) | ![](M4b/warnings-light.png) |
| First-visit hints | ![](M4b/onboarding-dark.png) | ![](M4b/onboarding-light.png) |
| Website: repo page | ![](M4b/web-diagram-dark.png) | ![](M4b/web-diagram-light.png) |
| Website: a page selected, code from GitHub | ![](M4b/web-selection-dark.png) | ![](M4b/web-selection-light.png) |
| Website: trace, step 3 | ![](M4b/web-trace-dark.png) | ![](M4b/web-trace-light.png) |

Smoke test on `shadcn-ui/taxonomy` (1440×900, the production explorer build):

| Broken down (40%, most of it off-screen) | Tracing `/dashboard/settings` |
|---|---|
| ![](M4b/smoke-taxonomy-drilled.png) | ![](M4b/smoke-taxonomy-trace.png) |

## Results (exactly as measured)

- **Tests (local, `pnpm test` at `bf97930`):** 2,812 passed, 16 skipped (worker tests that need Redis or Postgres; they run on CI). By package: viewer 963, analyzer 709, worker 466, web 340, diff 122, eval 77, db 71, schema 33, bench 31. Typecheck and lint clean.
- **E2E (local, `pnpm --filter @gitinside/web e2e`):** 18 passed in 20.1 s; the 9 website visual tests skip off Linux.
- **CI on `bf97930`** (run [41196250018](https://github.com/AbhinavGonthina/gitinside/actions/runs/41196250018)): `web-e2e` (E2E + website visual), `visual` (every story in dark and light), `worker-image`, and `check` green. Coverage (lines / branches, CI's `pnpm coverage`): viewer 99.23% / 94.03%, analyzer 97.88% / 91.13%, diff 99.01% / 93.61%, web 98.66% / 97.56%, worker 96.14% / 94.72% (incl. the Redis/Postgres tests), db 98.91% / 91.89%, eval 99.48% / 96.04%, schema 94.62% / 87.96%, bench 100% / 95.45%. All above target (analyzer and diff ≥ 85%, others ≥ 70%).
- **Render benchmark** (`bench/results/2026-10-31-render.md`, Chromium, one machine, re-run on the fixed code in M4b.15h): median 59.9 fps panning and zooming at 2,000 visible nodes on both graphs (p5 59.9 synthetic, 59.5 cal.com). Time to first drawn layout (opening the page to the canvas drawn, not ELK alone) at 2,000: 1,975 ms synthetic, 9,844 ms cal.com (M4b.15a's run: 1,476 ms and 9,152 ms). The target ("≥ 60fps at 2,000 nodes", where 60 means the median rounds to 60, ADR-0130) holds.
- **Eval:** unchanged by M4b (no analyzer, schema, or eval changes; report `eval/results/` regenerated when M4b.14a changed the lockfile, same scores).

## Acceptance criteria (ROADMAP M4b)

| Criterion | Result |
|---|---|
| UX.md interactions all work | Yes. The review's medium bugs (Esc under a filter, a stuck pan, focus lost in Filters, culling mid-glide, unreadable drill-downs) were fixed in M4b.15b–f, and the re-check's medium one (trace framing on a short canvas) in M4b.15h. Diff mode is M6/M8 by design. |
| E2E and visual tests green | Yes: 18/18 E2E locally; E2E and both visual jobs green on CI. |
| ≥ 60fps pan/zoom at 2,000 nodes in `bench/results/` | Yes: 59.9 fps median at 2,000 on synthetic and cal.com. |

## Key decisions and trade-offs

- **One ELK run per view, not per level** (ADR-0106). Compound frames, lines across frames, and stable order come from one layout, at the cost of a full re-layout per drill. A cache per expansion and filter state makes going back free.
- **Expand in place with Web Animations, not a library** (ADR-0108). The transition is a pure plan (glide, emerge, fold, fade) computed from two layouts, so it's tested without a browser and interrupted by planning again from what's on screen.
- **The trace is computed, never scripted** (ADR-0117): breadth-first reach within 12 hops for what's on the path, depth-first in call order for the steps, and nodes cut off at the limit are listed. An unresolved end quotes its reason (fail visibly).
- **Filters drop connections instead of re-routing them** (ADR-0120). Lifting a hidden node's edges to its parent would draw connections the code doesn't have.
- **Deep links say what they left out** (ADR-0122, 0123). Every value is checked against the graph, and a link from another commit opens with a note rather than silently opening somewhere else.
- **Big views trade sibling order for speed** (ADR-0131). Above 200 boxes, ELK's model-order step (18 of 24 s at 500 boxes on cal.com) is off; small views keep byte-identical layouts and baselines.
- **E2E on PGlite over the wire protocol** (ADR-0132). The production server and driver run unchanged, locally on Windows and on CI, without Docker.

## Hardest problem: cal.com's first layout

M4b.13b1's benchmark showed pan and zoom already at 60 fps, but cal.com's first layout took 56 s at 1,000 visible nodes and didn't finish in 10 minutes at 2,000, so the target couldn't even be measured there. Profiling in the browser was hopeless at that speed. Instead, M4b.13b2 dumped the real layout inputs to JSON and timed them in Node with ELK's own per-step timer (`measureExecutionTime`). Summing each step's own time showed one culprit at once: the model-order sort took 18 of 24 s at 500 boxes, whichever variant was chosen. Turning it off above a size threshold (and making one crossing-minimization pass on the biggest views) brought 1,000 boxes from 56 s to 2.5 s and 2,000 from "not done" to 9.2 s, with every small layout, story, and baseline unchanged. The lesson: dump once, time many, and use the library's own instruments before guessing.

## Smoke test

**CLI on a real public repo**, as a user would run it: `node packages/analyzer/dist/cli.js analyze eval/.repos/shadcn-ui__taxonomy --owner shadcn-ui --name taxonomy --sha 298a885… --out packages/analyzer/dist/smoke.json`. Exit 0, no output.

**The explorer on that graph** (scratch Playwright script on the production explorer build from `bench/render`, ELK in a Web Worker, 1440×900):

- First layout in 333 ms. The system level shows 5 boxes: the `taxonomy` service, its MySQL database, and Stripe, GitHub, and Postmark as external APIs.
- Double-click on the service drills in (47 boxes). The inspector says "Next.js service at the repo root with 14 pages, 9 routes, 5 models and 9 unresolved calls", matching the graph.
- Ctrl+K, typing `/dashboard/settings`, and Enter selects that page; T traces it: 2 steps ("page /dashboard/settings renders SettingsPage", "SettingsPage calls getCurrentUser"), with the file and line.
- Ctrl+K "user" ranks the `User` Prisma model first, then files.
- No page errors or console errors.

**What it showed** (see the screenshots above): after the drill-down the camera sits at the 40% floor, the box names are a few pixels tall, and most of the service is below the window. A route a user wants to click is off-screen, and Playwright's click on it timed out. In the trace, the camera centers on the start, so the step's other end (`app`) is off to the side. This is the same problem the M4b.14b baselines and the web reviewer flagged, and it's the biggest gap between the explorer and "a UI that looks genuinely good" on real repos. It's M4b.15f.

**After M4b.15f** (same graph and window size, 1280×800, `docs/milestones/M4b/framing/`): the drill-down opens at 80% with the service's name and its first entries readable, and each trace step shows both ends of its hop clear of the minimap and chips. When a hop's two ends are far apart, the camera zooms out to fit both (48% on taxonomy's step 2), so names get small again there.

| Broken down (80%) | Tracing `/dashboard/settings`, step 2 |
|---|---|
| ![](M4b/framing/taxonomy-drilled-dark.png) | ![](M4b/framing/taxonomy-trace-2-dark.png) |

**Website:** the seeded E2E (above) drives the production site the same way on `fixtures/shop-demo`; the deployed site waits on M5.13.

## Fresh-eyes review

Two subagents with no prior context reviewed `ff112af..HEAD`: one the model, layout, explorer, export, and benchmark code; one the chrome, styles, nodes, edges, image entry, website, and screenshots. They checked against SPEC.md, DESIGN.md, UX.md, DESIGN_SYSTEM.md, TESTING.md, SECURITY.md, and ADR-0100 to ADR-0133. I checked the medium findings against the code before accepting them. Together: no high, 6 medium, 10 low.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium | Esc ("up a level") and reveal ignore filters: `upFrom` (`drill.ts:35`) uses the unfiltered open set, so with a broken-down service hidden by a filter, Esc closes it off-screen, announces "Back to …", and doesn't clear the selection; the service is no longer broken down when shown again. | Fixed, M4b.15b (`6166ff5`) |
| 2 | Medium | A pan gets stuck after a release outside the canvas: capture starts only past the 4 px threshold and `pointermove` doesn't check `buttons` (`gestures.ts:111`), so moving back over the canvas with no button held pans. | Fixed, M4b.15b (`6166ff5`) |
| 3 | Medium | Culling uses the camera's destination while a 240 ms+ glide is on its way there (`Explorer.tsx:1020`), so on a big level everything outside the destination window vanishes during a palette pick or a far Tab. | Fixed, M4b.15c (`6dc7de4`): the window spans the glide's start and end |
| 4 | Medium | Keyboard focus is lost in Filters: Clear disables itself while focused (`FiltersPopover.tsx:169`), and a folder chip's remove button unmounts, so Esc and the explorer's keys stop working. | Fixed, M4b.15d (`fb05a03`) |
| 5 | Medium | Add to README and Share can be open at once, stacked in the same spot; Esc closes only the top one. | Fixed, M4b.15d (`fb05a03`) |
| 6 | Medium (UI) | Broken-down views at 1280×800 are mostly unreadable (40% fit floor, names at about 4–5 px, the right side under the inspector), and in a trace the inspector scrolls so the step's title is cut off. The smoke test showed the same on taxonomy. | Fixed, M4b.15f (`59dd75c`, ADR-0134): a drill-down frames the opened node at ≥ 80%, each trace hop frames its two ends, and the step header is sticky |
| 7 | Low | A trace step isn't clamped when the graph changes under a live trace (`Explorer.tsx:257`). | Fixed, M4b.15b (`6166ff5`) |
| 8 | Low | `cutOff` lists a depth-12 node even when everything past it is already on the path (`trace.ts:151`). | Fixed, M4b.15b (`6166ff5`) |
| 9 | Low | A `.` or `..` path segment survives `encodeURIComponent` in the code loader and the GitHub link (`sources.ts:139`, `chrome/describe.ts:40`), so a crafted graph path could read another repo's file from raw.githubusercontent.com (no cookies, no redirects, escaped text; our analyzer never writes such paths). | Fixed, M4b.15e (`61eb924`) |
| 10 | Low | The 2 MB source cap is checked only from `content-length`; a chunked response downloads in full first. | Fixed, M4b.15e (`61eb924`): the cap is enforced while the body streams |
| 11 | Low | Dismissing the deep-link note unmounts its focused button, and the note's `role="status"` arrives already filled, so it may not be announced. | Fixed, M4b.15d (`fb05a03`) |
| 12 | Low | The no-app card's headings skip from h2 to h4. | Didn't hold: they already went h2 → h3 → h4. A test now pins that order (M4b.15d). |
| 13 | Low | Under React StrictMode (dev only), the layout engine is disposed by the simulated unmount and later layouts silently run on the main thread. | Fixed, M4b.15g (`f67ef05`): the engine is made and disposed in one effect |
| 14 | Low | The benchmark's "First layout" includes navigation, bundle parse, and the worker's start, not only ELK. | Fixed, M4b.15g (`2cc40f7`): the column is "Time to first drawn layout" |
| 15 | Low | The address bar keeps a link's left-out parts until the first change, and each change replaces the whole query (drops `utm_*`). | Kept: Copy link always shares the cleaned state, and the note says what was left out. Written down here. |
| 16 | Low | The Filters popover scrolls with no visible hint that Folders is below. | Fixed, M4b.15d (`fb05a03`): a scroll shade |

The reviewers also confirmed these were fine: no `innerHTML` or `dangerouslySetInnerHTML` anywhere in the viewer (T10), Shiki tokens as React spans with a plain-text fallback; SVG export escaping and determinism, Mermaid labels through the diff's escaper, export file names; deep-link decoding (bad escapes, `__proto__`, every value checked, canonical encoding); trace BFS/DFS with cycles and a 5,000-hop iterative test; the layout cache's shared promises, eviction, and fallback; culling's always-drawn set; every listener, observer, frame, and timer cleaned up; the CSP's single added host; the share menu's focus and live regions; reduced motion; the error card.

## Re-check after the fixes (M4b.15h)

Every check was run again on the fixed code, without Turbo's cache.

- **Tests (local, `turbo run test --force` at `45d8643`):** 2,856 passed, 16 skipped (Redis/Postgres), 0 from cache. With the fix below, viewer is 1,004 and web 343 again.
- **CI on `cecc479`** (run [41205416638](https://github.com/AbhinavGonthina/gitinside/actions/runs/41205416638)): `check`, `visual`, `web-e2e`, and `worker-image` green; 2,873 tests passed with none skipped (worker 482 with Redis and Postgres). Coverage (lines / branches): viewer 99.28% / 94.19%, analyzer 97.88% / 91.13%, diff 99.01% / 93.61%, web 98.68% / 97.48%, worker 96.14% / 94.72%, db 98.91% / 91.89%, eval 99.48% / 96.04%, schema 94.62% / 87.96%, bench 100% / 95.45%. All above target.
- **E2E (local):** 18 passed in 21.3 s; the 9 website visual tests skip off Linux and ran green in CI's `web-e2e`.
- **Typecheck and lint** clean.
- **Render benchmark** re-run at `cecc479`: numbers above. Its report says "+ uncommitted changes" because PROGRESS.md and this doc were being edited, so no code was uncommitted.
- **Smoke test:** the analyzer hasn't changed since M4b.15a's CLI run. M4b.15f's browser run on taxonomy is the after-fix check (screenshots under "Smoke test").
- **Eval:** unchanged (no analyzer, schema, eval, or lockfile changes since).

**Third fresh-eyes review**, of the fixes alone (`2ff21df..HEAD`): one subagent with no prior context checked each finding against the code and its regression test. It found 1–11, 13, 14, and 16 fixed; 12 was right not to change code. New findings:

| # | Severity | Finding | Outcome |
|---|---|---|---|
| R1 | Medium | `frameHop` keeps 160px above and below the hop, so on a canvas 320px tall or less there's no room left and every trace step zooms out to 25%. | Fixed in M4b.15h (`cecc479`): each margin is at most a quarter of the canvas. The regression test failed first (zoom 0.25). |
| R2 | Low | The sticky step header can cover a focused step when Shift+Tab scrolls the inspector (no `scroll-padding-top`; WCAG 2.4.11). | M4b.16 |
| R3 | Low | The clamped trace step isn't stored, so a graph that shortens the path and then lengthens it again goes back to the old step. | M4b.16 |
| R4 | Low | The deep-link note's text is both in the live region and visible, so browse mode reads it twice. | M4b.16 |
| R5 | Low | Add to README doesn't reset "Copied" when the bar closes it. | M4b.16 |
| R6 | Low | Stale docs: ADR-0129 said a glide culls to its destination, and this doc still listed readability as open. | Fixed in M4b.15h (ADR-0129 in `cecc479`, this doc). |

## What's still weak

- **Readability on real repos** is better but not solved. M4b.15f frames a drill-down at 80% and each trace hop's two ends, but a hop between far-apart boxes still zooms out until names are small (48% on taxonomy), and a big service shows only its first entries at a readable size.
- **Four low findings from the re-check, queued as M4b.16:** the sticky step header can cover a focused step when the inspector scrolls (WCAG 2.4.11); a clamped trace step isn't stored, so a graph that grows again jumps back to the old step; the deep-link note is read twice in browse mode; Add to README doesn't reset "Copied" when the bar closes it.
- **A 2,000-box first layout takes about 9 s** on cal.com, and the layout at that size is huge (about 77,000 × 122,000 px). Measured on one machine.
- **Chromium only** in E2E, visual tests, and the benchmark.
- **A failed code load can be retried more often than needed** (M4b.14a saw five requests for one blocked file).
- **Diff mode** isn't built yet (M6's engine, M8's PR view).

## Interview questions

**1. The explorer re-lays out the whole view on every drill-down. Why not lay out each level separately and stitch them?**
Lines cross frame boundaries: a page inside `@shop/web` calls a route inside `@shop/api`. Laid out separately, each level would place its ports without knowing where the other ends are, so lines would zig-zag and frames would overlap. One ELK run over the compound graph routes every line and sizes every frame together. The cost is time per drill, which the cache per expansion state (going back is free) and the worker (the main thread keeps animating) hide. *Follow-up:* "What did it cost on cal.com?" Above 200 boxes, ELK's model-order step dominated; turning it off there (ADR-0131) means siblings can reorder between big views.

**2. How does the expand-in-place animation stay interruptible?**
A transition is a pure function of two layouts: which boxes glide (in both), which emerge from the opened node's center (new), which fold into it (gone), and which edges fade in after. It's run with the Web Animations API on transforms. If the user drills again mid-glide, the canvas reads where each box is on screen now and plans the next transition from there, so nothing jumps. Reduced motion uses the same plan with zero durations. It's tested without a browser because the plan is just data.

**3. Trace mode follows "the request". How do you decide what's on the path, and what stops it?**
Breadth-first from the page or route over the hop kinds (renders, calls, http, handles, reads, writes, stores, external_call, publishes, and consumes backwards), up to 12 hops, each node visited once so cycles end. That gives the set on the path. The steps are then ordered depth-first in call order so they read like the code runs. Nodes with hops past the limit are listed as cut off, and an unresolved end quotes the analyzer's reason instead of guessing. *Follow-up:* the review found `cutOff` can list a node whose targets are all already on the path (M4b.15b).

**4. Why are deep links checked against the graph instead of trusted?**
A link is untrusted input and can come from another commit. Decoding checks every node, step, filter, and folder value against this graph, drops what doesn't apply, and reports it in `ignored`, so the website can say "part of this link doesn't apply to this commit" rather than opening a different view without a word. Encoding is canonical (only what differs from the default, sorted), so the same state is always the same URL.

**5. You claim 60 fps at 2,000 nodes. How do you know the benchmark measured real work?**
The first run reported 59.9 fps with the camera parked over empty canvas: 0 boxes drawn. Now the benchmark counts boxes in the DOM every 15th frame and prints them next to the fps, starts each run at the busiest spot at 25% zoom, drives real wheel and pointer events at a trackpad's rate for 10 s, and takes fps from `requestAnimationFrame` deltas (median and p5). It runs the production build with ELK in a worker, on a synthetic graph and on cal.com, and records the commit and whether the tree was clean. Culling keeps about 50–210 boxes in the DOM at a time, which is why 2,000 visible nodes pan smoothly.

Quiz yourself: open Claude Code and say 'quiz me on M4b'.
