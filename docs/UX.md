# UX specification

Interaction spec for the explorer and website (v1). Visuals are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). Scope per SPEC §3 (D3.1, D3.2, D6.3). Not in v1: focus lens, the request-flow/data-model/infrastructure views, "Explain this", AI summaries.

Mockup v1 (interaction reference only, not visual): https://claude.ai/artifact/PAbBh6GSj1BwDd2R66xmEd

## Layout

- **Top bar:** logo, repo + branch/SHA chip, Ctrl+K search field, diff toggle (when a base exists), "Trace a request" button.
- **Canvas** (left, fills the space): the diagram, plus overlays:
  - Breadcrumbs (bottom-left).
  - Zoom controls (top-right).
  - Minimap + legend button (bottom-right).
  - Status chips (top-left, e.g. "Tracing…", "Comparing main → PR #12").
- **Inspector** (right, 340–380px, resizable): context for the selection. When nothing is selected, it shows the repo overview.
- **Under 880px:** canvas on top, inspector below. Mobile is a read-only explorer that stays legible (pan, zoom, select; no drag-editing).

## Drill-down (semantic zoom)

- **Levels:** System → Services → Modules → Files → Symbols (routes, pages, and models appear at the file level).
- **A service's first level leads with its routes** (design gate, ADR-0100): breaking a service down shows its entry points first (routes and pages, each linked to the file that defines it), then its folders as module frames, as the analyzer groups them. The levels below stay the same, and a route still appears inside its file when that file is opened (it moves there from the service's entries, so it's drawn once; ADR-0105).
- **Opening a node:** double-click, Enter, or the inspector's "Break down" button. The node expands **in place**: its frame grows, siblings glide aside, and children emerge from the parent's center (600ms layout motion). It never re-renders the whole canvas abruptly.
- **Going up:** Esc, or a breadcrumb, collapses back.
- **Zoom-dependent detail:** labels, counts, and edge labels appear progressively. At low zoom, show only service names and aggregated edges. Done in M4b.4b (ADR-0113): full detail from 65%; names only from 40%, keeping the pills of the selection, the current trace hop, and broken edges; below 40%, service names (scaled up to stay readable) and the lines between services, plus whatever is selected, traced, hovered, or focused.
- **Edge aggregation:** edges between hidden descendants are drawn between their visible ancestors, with counts ("22 calls").

## Selection and inspector

- **Selecting:** a single click selects. Its edges highlight and the rest soften.
- **The inspector shows:**
  - Kind and layer chip, name, subtitle (framework and path).
  - A summary sentence templated from graph facts. It's labeled "From the code", because there's no AI in v1.
  - Facts (counts, path, framework).
  - **Calls** and **Called by** lists (clickable; selecting flies there, drilling if needed).
  - Code preview (Shiki, the 15 lines around the source location), with a link to the file and line on GitHub at the analyzed commit (design gate).
  - **Open on GitHub** at the exact line, using the commit SHA permalink.
- **Unresolved nodes** explain why ("URL built from `CMS_URL` at runtime").

## Trace mode (signature)

- **Starting a trace:** the top-bar button, the T key, or "Trace from here" on a page or route in the inspector. A picker lists pages and routes, searchable.
- **The path:** a BFS from the start over `http → handles → calls → reads/writes → stores` and `external_call`/`publishes`, up to depth 12, ordered by call order within each function when known.
- **Display:** everything off the path dims to about 20%. Path edges turn `--trace`. A pulse travels each hop (900ms).
- **The player** (in the inspector): previous / play-pause / next, a step list, and each step's title, file:line, code, and match note ("Exact match: router.post('/') mounted at /api/orders").
- **Trace across zoom levels:** hops inside a collapsed node show "happens inside api; break it down to watch it." Drilling down keeps the trace active.
- **Exiting:** the Exit button, Esc, or T.

## Search: command palette

- **Opening it:** Ctrl+K or Cmd+K, or the top-bar field.
- **What it searches:** fuzzy match over services, modules, files, symbols, routes (`POST /api/orders`), pages, models, and externals. Results show kind and path.
- **Keys:** Enter flies to the result, drilling as needed, and selects it. Arrow keys navigate; Esc closes.

## Filters

- Popover from the top bar, with toggles by layer, kind, and confidence, a folder include/exclude, and "Hide tests and config" (on by default).
- Active filters show as a chip, with "Clear".

## Diff mode (M6)

- Shown when viewing a PR or `?base=<sha>`. Toggle between **Base**, **Head**, and **Overlay** (default).
- **Overlay colors:** added = green, changed = amber, removed = red (ghosted). Broken edge = pulsing dashed red with the label "route removed in this PR".
- **Layout stability:** nodes present in both versions keep their positions.
- **Changes list** (inspector): Added / Changed / Removed / Broken. Clicking an item flies to it.

## Deep links

- **Encoded in the URL:** repo, SHA, expansion path, selection, trace start and step, diff base, filters. For example: `/acme/shop/a1b2c3f?open=api,api/routes&sel=route:api/POST%20/api/orders&trace=page:web//checkout`.
- **Copy link** in the top bar's share menu.

## Export

- From the share menu: SVG and PNG of the current view (visible nodes only, both themes), or Mermaid (`flowchart`) of the current level.

## Website flows

- **Landing:** headline "Git inside your repo.", supporting line, URL field ("Paste a GitHub repo URL"), demo repo gallery, "Sign in for private repos" (from M8).
- **Analyze:** submit, then the progress page with real stages ("Downloading", "Parsing 1,204 files", "Linking 87 calls to routes", "Laying out") and queue position ("2 ahead of you"). It shows the error state with direction on failure.
- **Cached:** an instant redirect to the diagram.
- **README badge:** in the share menu, "Add to README" gives Markdown for the badge or live image (a `<picture>` with one source per theme), with a preview and Copy. Until M4b brings the top bar back, the button sits on the repo bar (ADR-0073).

## States

- **Empty repo or no TS/JS:** "We couldn't find a TypeScript or JavaScript app here. GitInside supports React, Next.js, Express, and Prisma in v1."
- **Over the limit:** "This repo has 31,402 source files, over the 20,000 limit. Try a subfolder: …" with a path input.
- **Private without access:** "This diagram is private. Sign in with a GitHub account that can see this repo."
- **Rate limited:** "You've analyzed 5 repos this hour. Try again at 14:32, or sign in for a higher limit."
- **Worker unavailable:** "Analysis is temporarily unavailable. Already-analyzed repos still work."

## Onboarding

On the first visit to a diagram, show 3 dismissible hints in sequence (zoom in → select → trace). "Don't show again" is stored per browser.

## Keyboard and accessibility

| Key | Action |
|---|---|
| Tab / Shift+Tab | move between nodes in reading order |
| Arrow keys | move to the nearest node in that direction |
| Enter | break down (or select if it has no children) |
| Space | select |
| Esc | close palette/popover → exit trace → go up a level → clear selection |
| T | toggle trace |
| Ctrl/Cmd+K | command palette |
| + / − / 0 | zoom in / out / fit |

A screen-reader live region announces the selection: "routes/orders, module. Calls payments, db. Called by web." Focus is always visible. `prefers-reduced-motion` turns transitions instant and pulses off.

## Copy rules

- Sentence case and plain verbs.
- Name things the way users recognize them: "Request path", not "edge traversal"; "Break down", not "expand subgraph".
- Errors say what happened and what to do, without apologizing.
