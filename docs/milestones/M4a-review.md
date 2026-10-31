# M4a review: Design system + clickable prototype (design gate)

**Tag:** `m4a` · **Range:** `m3..m4a` (M4a.1–M4a.9) · **Date:** 2026-10-28

**Status: waiting for Abhinav's design approval** ([planning #2](https://github.com/AbhinavGonthina/gitinside-planning/issues/2)). Every M4b task is blocked until then; non-UI work continues.

## What was built

A new `@gitinside/viewer` package with the visual language of the explorer: tokens, icons, nodes, edges, and chrome as React components with Storybook stories, plus a clickable prototype that draws a real analyzer graph. Nothing here is wired to the website yet (M5); ELK, pan/zoom, the trace BFS, and the palette's search are M4b.

| Piece | Where | What it does |
|---|---|---|
| Scaffold | `packages/viewer`, `.storybook/` | Vite library build (one ES module, React 19 peer), Storybook 8.6 with a dark/light `theme` global, Vitest + jsdom (ADR-0046) |
| Tokens | `src/tokens.ts`, `src/styles/tokens.css` | Dark (default) and light colors on `.gi-root[data-theme]`, type/space/radius/motion scales, focus ring, reduced motion ⇒ 0ms; TS and CSS checked against each other, AA contrast enforced by tests; self-hosted Geist (ADR-0047) |
| Icons | `src/icons/` | 56 Simple Icons logos mapped only from the node's own fields (framework, engine, host suffix); 14 custom stroke glyphs for generic kinds; brand color only when ≥ 3:1 on the tile, else monochrome (ADR-0048) |
| Nodes | `src/nodes/` | One `DiagramNode`, three tiers (frames for service/module, cards, icon-first for datastore/queue/external), unresolved as a dotted card with its reason in words; hover, selected, traced, dimmed, diff added/changed/removed as combinable data attributes (ADR-0049) |
| Edges | `src/edges/` | Pure geometry from route points; line style = confidence (solid, dot, dashed, dotted); labels from the edge's own fields; selected, traced, dimmed, diff, broken; flow particles via CSS motion path, off under reduced motion (ADR-0050) |
| Chrome | `src/chrome/` | Top bar, canvas overlays (status chips, zoom, breadcrumbs, minimap shell, legend built from the canvas's own tables), inspector parts, command palette shell (combobox), controls (ADR-0051) |
| Prototype | `src/prototype/`, `fixtures/shop-demo` | `ExplorerPrototype` draws the new fixture's golden graph: drill one level, select, a trace script checked against the graph, Esc/T/Enter/Space (ADR-0052) |
| Visual regression | `visual/`, CI `visual` job | Every story × dark/light (52 shots), captured and compared in the pinned Playwright Linux image, strict comparison (ADR-0053) |

The visual language is written down in [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) §3–§4, marked "pending the design gate".

## Screenshots

Rendered by CI in the pinned Linux Playwright image (they're the committed visual baselines, copied here so this doc doesn't change when baselines do). 1280×800, scale 1.

### The prototype (the explorer as it will feel)

| | Dark | Light |
|---|---|---|
| System level | ![](M4a/explorer-overview-dark.png) | ![](M4a/explorer-overview-light.png) |
| `@shop/api` broken down, a route selected | ![](M4a/explorer-broken-down-dark.png) | ![](M4a/explorer-broken-down-light.png) |
| Trace, step 3 (`placeOrder` → `POST /api/orders`) | ![](M4a/explorer-tracing-dark.png) | ![](M4a/explorer-tracing-light.png) |
| Trace inside `@shop/api`, step 5 | ![](M4a/explorer-tracing-broken-down-dark.png) | ![](M4a/explorer-tracing-broken-down-light.png) |

### Components

| | Dark | Light |
|---|---|---|
| Nodes: every kind | ![](M4a/nodes-kinds-dark.png) | ![](M4a/nodes-kinds-light.png) |
| Nodes: every kind × every state | ![](M4a/nodes-states-dark.png) | ![](M4a/nodes-states-light.png) |
| Edges: confidence | ![](M4a/edges-confidence-dark.png) | ![](M4a/edges-confidence-light.png) |
| Edges: plain, trace, diff | ![](M4a/edges-diagram-dark.png) | ![](M4a/edges-diagram-light.png) |
| Inspector | ![](M4a/chrome-inspectors-dark.png) | ![](M4a/chrome-inspectors-light.png) |
| Command palette | ![](M4a/chrome-palette-dark.png) | ![](M4a/chrome-palette-light.png) |
| Logos | ![](M4a/icons-logos-dark.png) | ![](M4a/icons-logos-light.png) |
| Glyphs | ![](M4a/icons-glyphs-dark.png) | ![](M4a/icons-glyphs-light.png) |
| Tokens | ![](M4a/tokens-sheet-dark.png) | ![](M4a/tokens-sheet-light.png) |

All 52 (every story in both themes) are in [`packages/viewer/visual/baselines/`](../../packages/viewer/visual/baselines/). To click through it yourself: `pnpm --filter @gitinside/viewer storybook`, then **Prototype/Explorer → Overview**. Double-click a service, press T, step with Next, Esc back out.

### Checked against DESIGN_SYSTEM.md §2 and §6

- **Reads as a system design diagram?** Yes at the system level: four boxes in request order (web → api → database and Stripe), labeled lines, real logos. Broken down, the API frame shows its folders as translucent nested frames.
- **Anti-pattern list (§2):** no dot or square grid (the canvas is a flat themed surface); every kind has an icon, so no bare shape is the only marker; the accent is a calm blue, not acid green, and there is no cream/terracotta; no gradient washes; no ALL-CAPS eyebrows or emoji; Geist sans for labels, Geist Mono only for code-like text (paths, symbols, routes); not Inter or Space Grotesk. **Closest to the line:** the card tier (file, symbol, route, page, model) is a family of similar rounded cards. They differ by icon, mono vs sans, chips, and counts, and use no shadow, but at a glance a grid of them is uniform (see "For you to decide").
- **Every device maps to §3:** icon = technology or kind, container = tier, layer = tint and ring, line style = confidence, badges = counts and diff, edge label = relationship + protocol, never guessed.
- **Contrast, focus, motion:** text ≥ 4.5:1 and graphics ≥ 3:1 on every surface in both themes are unit-tested (113 token tests); focus is a 2px offset accent ring, distinct from selection; reduced motion turns layout motion, flow particles, and the broken pulse off.

## Results (exactly as measured)

- **Tests:** 1,123 green after the review fixes (analyzer 580, viewer 443, eval 77, schema 15, bench 8); 1,117 before them (viewer 437). Lint, typecheck, the library build, and Storybook build green. The analyzer's wall-clock "exponentially shared mounts" test failed once at 28.5 s under the full parallel coverage run (budget 20 s; a known lesson) and passed on the rerun by itself.
- **Coverage (lines):** viewer 99.7% (target 70%), analyzer 97.54% (85%), eval 99.48%, schema 98.85%, bench 100%.
- **Visual regression:** 52 baselines; CI's `visual` job compares every push. A trial run reproduced every shot on reruns.
- **Library size:** `dist/index.js` 108.7 kB (39.2 kB gzip), `style.css` 39.0 kB (7.0 kB gzip); Geist stays an external import.

## Key decisions and trade-offs

- **Theme on one attribute** (ADR-0046, 0047): every color is a CSS variable keyed on `data-theme`, so switching themes re-renders nothing. The tokens exist twice (TS for tests and canvas math, CSS for styling), and a test keeps them identical, which also lets contrast be tested in Vitest instead of eyeballed.
- **Icons come only from the node's own fields** (ADR-0048). A host matches a brand by label-boundary suffix, longest first; anything Simple Icons doesn't ship gets the kind's glyph. A wrong logo would be a guess, and the product doesn't guess.
- **States are combinable data attributes, not variants** (ADR-0049). A node can be selected, traced, and "Changed" at once; CSS decides precedence (selected > traced > diff > hover). One component, tested as a full kind × state matrix.
- **Our own edge geometry over a library's** (ADR-0050): ELK will give route points; drawing them ourselves keeps rounded bends, arrow bases, and label anchors deterministic and testable as pure functions.
- **The prototype draws real analyzer output** (ADR-0052): a new fixture with a whole request path, drawn from its golden graph, and a hand-written trace that `checkTrace` validates against the graph, so even the "fake" trace can't show an edge the analyzer didn't find. Aggregated edges take the **weakest** confidence.
- **Baselines from Linux CI, strict, reviewed by a person** (ADR-0053): fonts rasterize differently on Windows, so capture and comparison happen in one pinned image; no pixel tolerance, because the gate is about 1px borders.

## Hardest problem: making "looks good" checkable

Design quality is the one pillar that can't be scored like accuracy. M4a turned as much of it as possible into tests, so later work can't quietly regress it:

1. **Contrast as a unit test.** Every text token is checked at ≥ 4.5:1 and every essential graphic (accent, layers, trace, diff, resting edge strokes) at ≥ 3:1 on every surface, in both themes. When light theme values were finalized, failing ratios drove the choices, not the other way round.
2. **Labels from data, in words.** Every node and edge label is a pure function of graph fields (`describe.ts`), tested per kind: `POST /api/orders · HTTP`, `reads id, total`, "URL built from CMS_URL at runtime". No label can say something the graph doesn't.
3. **CSS rules as tests.** `*Css.test.ts` files parse the stylesheets and reject raw colors and raw durations (so reduced motion can't be bypassed) and check the state precedence.
4. **Every story, both themes, pixel-strict in CI.** The harness asserts the theme, tokens, and fonts actually applied before each screenshot, so it can't pass on an unstyled page.
5. **The screenshot self-critique** on every task caught what tests didn't: an invisible dark elevation, a diff badge squeezing names, stacked edge labels, a story drawn on white past the viewport, and focus lost after opening a frame.

## What's still weak

- **The layout is a fixed column layout** for one small graph. Real repos need ELK (M4b.2); how frames, labels, and long edges look under ELK is untested.
- **The prototype is one level deep** and has no pan/zoom, palette search, filters, share, or trace play button.
- **The trace is scripted,** not computed (BFS is M4b.6).
- **Label collisions:** in "Trace inside `@shop/api`", the dimmed `reads id, total` pill sits partly under the `writes status, total` pill. Expected to go with ELK edge labels.
- **jsdom misses browser behavior.** Two focus bugs (M4a.7, and one found in this review) only showed up in a real browser. M4b.14's Playwright E2E is where that gets covered.
- **Visual baselines can't be re-captured locally** (no Docker here); every pixel change goes through a dispatch workflow and a download.

## Fresh-eyes review

A subagent with no prior context reviewed `m3..HEAD` against SPEC.md, ROADMAP M4a, DESIGN.md, DESIGN_SYSTEM.md, UX.md, TESTING.md, SECURITY.md, ADR-0046 to ADR-0053, and CLAUDE.md, running scratch scripts against the fixture graph and computing contrast. It found nothing high-severity: 3 medium and 6 low findings. The fixes are in `c2bfc8a` (ADR-0054), each with a test that fails without it.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium | Inspector rows were keyed by node, but `src` reaches `Order` by both `reads` and `writes`, so React saw a duplicate key (confirmed on the fixture). | Fixed: keyed per row; a test selects `src` and fails on React's duplicate-key warning. |
| 2 | Medium | Tab went db → Stripe → api → web (graph ID order), right to left, and an open frame's children came last (UX.md, WCAG 2.4.3). | Fixed: `layout()` returns a reading order and the canvas renders in it. |
| 3 | Medium | The current trace step's number was `--trace` text: 3.71:1 in light (AA text needs 4.5:1). Token tests only hold `--trace` to the 3:1 graphics bar. | Fixed: a 3px trace bar marks the step; text stays `--text`; a CSS test forbids trace-colored text. |
| 4 | Low | Canvas nodes are focusable `role="group"` with click handlers, and selection and expansion are only in `aria-label` text; no arrow keys. | **Deferred to M4b.11**, which builds keyboard navigation and screen-reader support for the real canvas. |
| 5 | Low | Esc didn't close the legend first (UX.md: popover → trace → level → selection). | Fixed, with focus back on the Legend button. |
| 6 | Low | The palette shell is `aria-modal` but doesn't take or trap focus. | **Deferred to M4b.7** (the palette is a shell until then). Done in M4b.7: focus moves into the field on open, stays there (Tab, presses in the dialog), and goes back on close (ADR-0119). |
| 7 | Low | The visual spec didn't fail on a baseline no story produces, and only checked Geist, not Geist Mono. | Fixed: an orphan check (compare runs only) and a mono check wherever mono is used. |
| 8 | Low | `ci.yml` had no `permissions:`, so jobs got the repo's default token. | Fixed: `contents: read`. |
| 9 | Low | `brands` sorted with a hand-written comparator instead of `compareStrings`; a stale doc comment in `trace.ts`. | Fixed. |
| 10 | Low | `dist/index.js` imports the Fontsource CSS, so the library can't be imported by plain Node (`ERR_UNKNOWN_FILE_EXTENSION`). | **Deferred to M5.2**, when apps/web first consumes the viewer: a separate fonts entry. |

The reviewer also confirmed these were fine: edge geometry edge cases (short and single segments, repeated points, short jogs); the minimap fit and layout helpers; edge lifting (inner edges dropped, weakest confidence, stable order); `checkTrace` rejecting missing edges, discontinuous hops, and unknown starts; logo matching only at a label boundary with no guessed logos; the WCAG contrast formula; labels never guessing a protocol; no `dangerouslySetInnerHTML`/`innerHTML` (graph strings are escaped text), `offset-path` built from numbers only, GitHub links always `https://github.com/` with encoded segments; `serve.mjs` limited to its folder, GET/HEAD, loopback; no untrusted `${{ }}` in workflows; reduced motion stopping every infinite animation; the focus ring winning over the palette's `outline: none`; every node kind and edge kind/confidence in every state in Storybook; no §2 anti-pattern in the CSS; and a visual harness that can't pass empty.

**Two notes for the design gate** (no change made): a file's inspector says "This calls nothing in the repo." while hiding its imports, which is accurate but could mislead; and dimmed nodes in trace mode (20% opacity) are below text contrast but still focusable, as the spec asks.

**After the fixes:** 443 viewer tests (1,123 total) green, viewer 99.7% lines, lint, typecheck, and both builds green; the click-through below passes in both themes. The tracing stories' baselines were re-captured in Linux CI for the new step marker.

## Smoke test

The built Storybook, served statically and driven in Chromium (scratch Playwright script), as a user would click it, in both themes: open **Prototype/Explorer**, click `@shop/api` (inspector heading becomes `@shop/api`), double-click it (4 ⇒ 6 boxes), press T ("Tracing /checkout"), click **Next step** three times ("Step 4 of 8"), then Esc, Esc. No page or console errors.

It found one bug: the second Esc did nothing. The first Esc ended the trace, which removed the focused **Next step** button, so focus fell to the page and the explorer stopped hearing keys. Fixed in `c2bfc8a`: after the fix the same run puts focus on `@shop/web` (where the trace started) and the second Esc goes back to the system level (6 ⇒ 4 boxes), in both themes, with no errors.

## The design gate

Opened as [planning #2](https://github.com/AbhinavGonthina/gitinside-planning/issues/2) (`needs-abhinav`, `design-gate`). Every M4b task is tagged `{blocked: design gate #2}`; autopilot continues with M5's non-UI work. When the issue is closed, its comments are applied to DESIGN_SYSTEM.md and the components before M4b.1.

**For you to decide** (answer in the issue; anything you change goes into DESIGN_SYSTEM.md and the components before M4b starts):
1. **Overall direction:** does it read as a system design diagram you'd want to explore, in both themes?
2. **The card tier:** files, symbols, routes, pages, and models share one card shape. Keep it (icon and type carry the kind), or give routes/models a more distinct shape?
3. **Trace emphasis at the system level:** every box is on the checkout path, so everything lights up. Should the current hop stand out more there?
4. **First level of a service:** breaking down `@shop/api` shows its folders (`prisma`, `src`), as the analyzer groups them, not its routes. Lead with routes instead?
5. **Light theme:** polished enough, or does it need another pass?

## Interview questions

**1. How do you make sure a node's logo is never wrong?**
Logos are only chosen from fields the analyzer read from the repo: `service.framework` from dependencies, `datastore.engine` from compose images or Prisma, `external.host` from literal URLs and the SDK allowlist. A host matches a brand only at a label boundary, longest suffix first (`maps.googleapis.com` is Google Maps, not Google), and anything without a shipped logo gets the kind's glyph. *Follow-up:* "What about a brand whose color is unreadable on the tile?" The fill falls back to the text color when the brand color is under 3:1 against the tile in that theme; both fills are set on the element and CSS picks one per theme.

**2. Why are node states data attributes instead of component variants?**
States combine: a node can be selected while traced and marked "Changed" in a diff. Variants would need a combinatorial explosion of props or a precedence rule in JS. Data attributes let CSS express precedence once (selected > traced > diff > hover for the border), and a test renders every kind in every state so the matrix stays complete.

**3. An aggregated edge covers one exact and one heuristic hop. What line style does it get, and why?**
Dashed (heuristic), the weakest. A line must never look more certain than its shakiest part; showing the strongest would draw a solid line over a guess-level match, which contradicts "fail visibly". The count label ("2 requests") says it's an aggregate.

**4. How do you test that a design is accessible without a person looking at it?**
Parts of it are mechanical: contrast ratios computed from the token values for every text/surface and graphic/surface pair in both themes; reduced motion as a token (all durations come from tokens, and a CSS test rejects raw durations); roles and names asserted in jsdom (combobox, listbox, live region announcements, accessible node names). What's not mechanical, such as focus moving correctly when elements are swapped, needs a real browser, which is why the screenshot pass and Playwright runs exist.

**5. Why capture visual baselines in a Docker image instead of on your machine?**
Font rasterization differs by OS, GPU, and browser build, so a Windows baseline would fail on Linux CI every time. Capturing and comparing in the same pinned image (`playwright:v1.64.1-noble`, matching `@playwright/test`) makes a pixel difference mean the UI changed. *Follow-up:* "Why no pixel tolerance?" The design gate cares about 1px borders and small color shifts; a tolerance would hide exactly those.

Quiz yourself: open Claude Code and say 'quiz me on M4a'.
