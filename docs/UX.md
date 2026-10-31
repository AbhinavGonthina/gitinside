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
- **Readable after a drill-down** (M4b.15f, ADR-0134): a level that fits the canvas at 80% or more is fitted; a bigger one opens on the node just broken down, its name and entries at 80% or more, and 0 shows the whole level. Each trace step brings its hop's two ends into view at a readable size, and the step's title stays at the inspector's top.
- **Zoom-dependent detail:** labels, counts, and edge labels appear progressively. At low zoom, show only service names and aggregated edges. Done in M4b.4b (ADR-0113): full detail from 65%; names only from 40%, keeping the pills of the selection, the current trace hop, and broken edges; below 40%, service names (scaled up to stay readable) and the lines between services, plus whatever is selected, traced, hovered, or focused.
- **Edge aggregation:** edges between hidden descendants are drawn between their visible ancestors, with counts ("22 calls").

## Selection and inspector

- **Selecting:** a single click selects. Its edges highlight and the rest soften.
- **The inspector shows:**
  - Kind and layer chip, name, subtitle (framework and path).
  - A summary sentence templated from graph facts. It's labeled "From the code", because there's no AI in v1.
  - Facts (counts, path, framework).
  - **Calls** and **Called by** lists (clickable; selecting flies there, drilling if needed).
  - Code preview (Shiki, the 15 lines around the source location), whose file path links to the file and line on GitHub at the analyzed commit (design gate). It loads when selected (the website reads public files from GitHub in the browser, ADR-0115); while loading the frame keeps its height, and a file that can't load says so.
  - **Open on GitHub** at the exact line, using the commit SHA permalink, whether or not the code loaded.
- **Unresolved nodes** explain why ("URL built from `CMS_URL` at runtime").

## Trace mode (signature)

- **Starting a trace:** the top-bar button, the T key, or "Trace from here" on a page or route in the inspector. A picker lists pages and routes, searchable. Done in M4b.6b (ADR-0118): T and the Trace button trace a selected page or route (or the demo's start); otherwise they open the picker, which matches every word against names and files. Enter or a click traces; focus goes back where it was.
- **The path:** a BFS from the start over `http → handles → calls → reads/writes → stores` and `external_call`/`publishes`, up to depth 12, ordered by call order within each function when known. Done in M4b.6a (ADR-0117): steps go depth-first in call order, `consumes` is followed from the queue to its worker, an unresolved end says why, and where the 12-hop limit cuts the path is listed under the steps.
- **Display:** everything off the path dims to about 20%. Path edges turn `--trace`. A pulse travels each hop (900ms): the current hop's line, the request's way along it; off under reduced motion.
- **The player** (in the inspector): previous / play-pause / next, a step list, and each step's title, file:line, code, and match note ("Exact match: router.post('/') mounted at /api/orders"). Play shows each step for three pulses (2.7 s) and stops on the last (then Replay); a step picked by hand pauses it.
- **Trace across zoom levels:** hops inside a collapsed node show "happens inside api; break it down to watch it." Drilling down keeps the trace active.
- **Exiting:** the Exit button, Esc, or T.

## Search: command palette

- **Opening it:** Ctrl+K or Cmd+K, or the top-bar field.
- **What it searches:** fuzzy match over services, modules, files, symbols, routes (`POST /api/orders`), pages, models, and externals. Results show kind and path.
- **Keys:** Enter flies to the result, drilling as needed, and selects it. Arrow keys navigate; Esc closes.
- Done in M4b.7 (ADR-0119): every word must match the name (whole, start, word start, anywhere, or its letters in order) or the path, ranked in that order with kinds breaking ties; up to 50 results. A pick zooms in until it reads (up to 100%) and takes focus. Focus stays in the dialog until it closes, then goes back where it was.

## Filters

- Popover from the top bar, with toggles by layer, kind, and confidence, a folder include/exclude, and "Hide tests and config" (on by default).
- Active filters show as a chip, with "Clear".
- Model done in M4b.8a (ADR-0120): a hidden node takes what's inside it along, and a folder left empty goes too; its connections are dropped, not redrawn from its parent. Hiding a confidence hides lines only. Tests and config are found by name (`*.test.*`, `*.spec.*`, `*.config.*`, `__tests__/`, `tests/`, `e2e/`, …).
- Popover and chip done in M4b.8b (ADR-0121): only what the graph has is offered, with counts; connection kinds (imports off by default) are toggles too; a folder not in the repo is refused with a message. The chip ("2 filters · 7 hidden") shows only when something is hidden; its text opens the popover, its × clears. Going to a hidden node (search, the trace picker, a connection, a trace's start or step) takes off just the filters hiding it; a hidden selection or hop says so in the inspector, with a Show button.

## Diff mode (M6)

- Shown when viewing a PR or `?base=<sha>`. Toggle between **Base**, **Head**, and **Overlay** (default).
- **Overlay colors:** added = green, changed = amber, removed = red (ghosted). Broken edge = pulsing dashed red with the label "route removed in this PR".
- **Layout stability:** nodes present in both versions keep their positions.
- **Changes list** (inspector): Added / Changed / Removed / Broken. Clicking an item flies to it.

## Deep links

- **Encoded in the URL:** repo, SHA, expansion path, selection, trace start and step, diff base, filters. For example: `/acme/shop/a1b2c3f?open=api,api/routes&sel=route:api/POST%20/api/orders&trace=page:web//checkout`.
- **Copy link** in the top bar's share menu.
- Encoding done in M4b.9a (ADR-0122): only what differs from the default is written (`open`, `sel`, `trace`, `step` 1-based, `hideLayers`, `hideKinds`, `hideConfidence`, `hideLines`, `only`, `hideFolders`, `tests=shown`). A link's node, step, or filter value that this commit doesn't have is left out and listed, so the page can say so.
- On the website in M4b.9b (ADR-0123): the repo page opens from its query and keeps it in step as you explore (`history.replaceState`, so Back still leaves the page). A link that doesn't fully apply says so above the diagram ("Part of this link doesn't apply to commit a1b2c3d, so it was left out: …"), with Dismiss. Share (the explorer's top bar, or the repo bar next to "Add to README") shows the link with **Copy link**; the link is the commit's permalink, so it keeps opening the same diagram after newer commits.

## Export

- From the share menu: SVG and PNG of the current view (visible nodes only, both themes), or Mermaid (`flowchart`) of the current level.
- Renderers done in M4b.10a (ADR-0124): the SVG is the view at the canvas's layout positions (open frames, boxes, lines, pills, and a footer with the repo and commit), always at full detail, without the selection or trace. The Mermaid lists the visible nodes, a broken-down node as a subgraph around its inside, lines labelled as on the canvas (heuristic and unresolved ones dotted).
- In the share menu since M4b.10b (ADR-0125): under the link, **Export this view** has SVG and PNG with a Dark / Light choice (starting from the screen's theme), and Mermaid saved as `.mmd` or copied. The PNG is the SVG at 2× (smaller only when a browser's canvas limit requires it, and it says so). Files are made in the browser and named `owner-name-sha7[-theme]`; a live region says what was saved.

## Website flows

- **Landing:** headline "Git inside your repo.", supporting line, URL field ("Paste a GitHub repo URL"), demo repo gallery, "Sign in for private repos" (from M8).
- **Analyze:** submit, then the progress page with real stages ("Downloading", "Parsing 1,204 files", "Linking 87 calls to routes", "Laying out") and queue position ("2 ahead of you"). Once parsing starts, the time left shows under the bar ("About 40 s left", "About 3 min left"), estimated from the repo's file count and measured times of past analyses (the cal.com benchmark until there are five), updated per step; past the estimate it says "Taking longer than usual", and before parsing there's none (ADR-0136). It shows the error state with direction on failure. As the analyzer finds them, "Found so far" under the stages lists the services by name ("2 services: @shop/api, @shop/web"), the entry points ("12 routes, 3 pages"), the data stores, and the outside services, only what the analyzer itself produced, each row easing in as it arrives (ADR-0135). While it runs, the page says the analysis keeps going if you leave and offers its own link with Copy; reopening the link shows the live progress, or opens the diagram once it's done. A link reopened after its job is forgotten (24 hours) offers "Open the diagram" (the repo page) beside "Analyze again".
- **Cached:** an instant redirect to the diagram.
- **README badge:** in the share menu, "Add to README" gives Markdown for the badge or live image (a `<picture>` with one source per theme), with a preview and Copy. Until M4b brings the top bar back, the button sits on the repo bar (ADR-0073).

## States

- **Empty repo or no TS/JS:** "We couldn't find a TypeScript or JavaScript app here. GitInside supports React, Next.js, Express, and Prisma in v1."
- **Over the limit:** "This repo has 31,402 source files, over the 20,000 limit. Try a subfolder: …" with a path input.
- **Private without access:** "This diagram is private. Sign in with a GitHub account that can see this repo."
- **Rate limited:** "You've analyzed 5 repos this hour. Try again at 14:32, or sign in for a higher limit."
- **Worker unavailable:** "Analysis is temporarily unavailable. Already-analyzed repos still work."
- **Diagram fails to load or parse** (M4b.12b2): the same card as "no app", in the error tone, where the diagram goes: "The diagram didn't load" (the server's words, or "Check your connection and try again") with Try again, or "The saved diagram couldn't be read" (nothing is drawn rather than part of it; the problem is on our side) with no retry. Focus moves to the card.

## Onboarding

On the first visit to a diagram, show 3 dismissible hints in sequence (zoom in → select → trace). "Don't show again" is stored per browser.

Done in M4b.12a (ADR-0127): one small card at the top of the canvas ("Tip 1 of 3", the title and a sentence, "Don't show again", Next). Breaking a node down, selecting one, or starting a trace moves on from the hint asking for it, as Next does; on the last, Done. Finishing them is remembered like "Don't show again"; the close button or Esc hides them for this visit only. A hint a deep link has already done, or one this repo can't do (nothing to trace), is left out. The website keeps the choice in `localStorage`.

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

Done in M4b.11 (ADR-0126): the boxes are a tree ("Architecture") of tree items with their level, place among their siblings, broken down or not, and selected or not. Arrows with a modifier are left to the browser and screen reader. A box focused from the keyboard glides into view (a box bigger than the canvas by its top-left corner, where its name is); a click doesn't move the camera. The announcement names each end once, five per list, then "and N more"; clearing the selection says "Selection cleared".

## Copy rules

- Sentence case and plain verbs.
- Name things the way users recognize them: "Request path", not "edge traversal"; "Break down", not "expand subgraph".
- Errors say what happened and what to do, without apologizing.
