# Design system

**Status:** M4a's visual language passed the design gate on 2026-10-30 ([planning #2](https://github.com/AbhinavGonthina/gitinside-planning/issues/2)), with the changes in §1.1 still to make (tasks M4b.0a–M4b.0e, ADR-0100). Update this file with every approved change. Decisions: D6.1–D6.4.

### 1.1 Design gate outcome (2026-10-30)

Abhinav's review of [M4a-review.md](milestones/M4a-review.md), in his words where it matters:

- **Kept as is:** tokens, logos, glyphs, edge confidence styles, node states, the inspector ("looks clean"), the command palette ("kinda like Mac, that's nice"), the broken-down service's sidebar, the code sample in the inspector, and the light theme ("looks clean and good"). Overall it reads as a system design diagram he'd explore in both themes, "good for a first run"; the diagram should get richer later.
- **Fix: content must fit its container.** `@shop/web`'s count badges wrapped onto a second line and spilled out of its closed frame. Every node is sized from its content (M4b.0a).
- **Change: a distinct shape per layer and kind** (gate questions 1 and 2). Too many similar shapes stand for different things. Each layer gets its own shape that makes sense in a system design drawing (a frontend service doesn't look like a backend service; data is already separate), and routes, pages, and models get shapes of their own instead of sharing the card. Shapes stay in today's style (quiet, hairline, tinted) and the icon stays the primary marker, so §2's "plain primitive as the only marker" still holds (M4b.0b).
- **Change: the current trace hop stands out** (question 3). Where the whole path is lit, the reader must still see where in the flow they are: the current hop's nodes and edge are clearly stronger than the rest of the path (M4b.0c).
- **Change: a service's first level leads with its routes,** then its folders (question 4). See UX.md "Drill-down" (M4b.1, M4b.3).
- **Change: the code sample links to the file on GitHub,** at the commit and line (M4b.5).
- **Change: a new GitInside mark.** "Not a fan of the logo right now" (M4b.0d).
- **Change: natural motion everywhere,** so it runs like a smooth modern web app, and it should look as little AI-coded as possible while staying polished and clean (M4b.0e; every M4b task).

## 1. Direction: "Living system diagram"

GitInside should read **instantly as a system design diagram** an engineer would draw, and explore **like a map**:
- Services are translucent frames that open in place into modules, then files, then symbols.
- Detail fades in with depth.
- Requests travel along routes.

**References** (Abhinav's picks):
- **Eraser:** clean nodes with real, full-color technology logos.
- **Linear:** quiet, precise chrome; keyboard-first.
- **Vercel / Stripe docs:** strong typography, careful spacing, tasteful motion.

**Where boldness goes:** the canvas is the hero. Chrome (top bar, inspector, palette) stays quiet and disciplined.

**Theme:** dark first; a fully polished light theme from the same tokens.

**Signature moment:** trace mode. The demo leads with it, then drill-down, then PR diff.

## 2. What to avoid

Abhinav's feedback on mockup v1 (2026-10-25): it "looks Claude-coded and simple." Concretely, **do not use:**
- A dot-grid or square-grid canvas background.
- Plain geometric primitives as the only kind marker (bare rectangles, hexagons, chamfered boxes).
- Generic AI-design defaults:
  - Near-black with a lone acid-green accent.
  - Cream with terracotta.
  - Identical rounded cards with the same soft shadow everywhere.
  - Decorative gradient washes, purple-to-blue gradients.
  - ALL-CAPS eyebrow labels, emoji as icons.
  - A monospace face for every small label.
  - Inter or Space Grotesk as the default face.

Every M4a review checks screenshots against this list.

## 3. Node visual language (every device means something)

| Device | Encodes |
|---|---|
| **Icon** (primary marker) | Technology when known (Next.js, Express, Postgres, Redis, Stripe… real logos), otherwise kind (custom glyph for route, function, module, file, model, queue, unresolved) |
| **Container style** | Kind tier: services and modules are frames (translucent, contain children); files and symbols are compact cards or rows; datastores, queues, and externals are icon-first nodes (large icon tile, label beneath, Eraser-style) |
| **Layer color** | Frontend / backend / data / infra / external. Used as a restrained accent (frame tint, icon-tile ring, edge flow color), never a full fill |
| **Line style** | Confidence: solid = exact, solid with a small dot marker = pattern, dashed = heuristic, dotted = unresolved |
| **Badges** | Counts (routes, callers, unresolved calls), diff state |
| **Edge label** | Relationship + protocol, e.g. `POST /api/orders · HTTPS` |

The legend is always one click away and is generated from these same tokens.

**Node components** (implemented in M4a.4, `packages/viewer/src/nodes/`; approved at the design gate, changes in §1.1; ADR-0049). Story **Components/Nodes** shows Kinds, States (every kind × every state), and Frames.
- **Tiers:**
  - **Frames** (service, module). Closed: a solid card tinted 10% with the layer, a layer-mixed border, counts on their own row (the frame widens past 248px rather than let them wrap out of it; a visual test checks no node's content overflows), and a **stacked edge** beneath meaning "there is more inside; break it down". Open: translucent (6% layer tint), header row on top, children inside; nested frames deepen the tint. Service radius 16, module 12.
  - **Cards** (file, symbol, route, page, model, unresolved): `surface-1`, radius 10, small tile, name and muted subtitle, counts on the right. Symbols, page paths, and unresolved expressions use Geist Mono; a route's method sits in a quiet mono chip before its path.
  - **Icon-first** (datastore, queue, external): large tile, name beneath, engine or brand beneath that. No container until a state needs one.
  - **Unresolved:** a dotted card on the canvas color, its reason in words ("URL built from CMS_URL at runtime").
- **Subtitles** come from the node's own fields: framework + root, folder path, "Exported function", "6 fields", "PostgreSQL", "Redis queue", the brand of a host.
- **States** (combine freely; the border goes to the highest: selected > traced > diff > hover):
  - **Hover:** `surface-2` fill (frames: a stronger tint) and a stronger border.
  - **Selected:** 2px `--accent` border and a faint accent fill. Distinct from the keyboard focus ring, which is an offset outline.
  - **Traced:** `--trace` border plus a soft trace glow, kept when also selected.
  - **Dimmed:** 20% opacity (50% on hover).
  - **Diff:** a worded tag on the top edge ("Added", "Changed", "Removed") with a colored dot, plus a diff-colored border and tint. Removed is also dashed, ghosted to 50%, and struck through.

**Edge components** (implemented in M4a.5, `packages/viewer/src/edges/`; approved at the design gate, changes in §1.1; ADR-0050). Story **Components/Edges** shows Confidence, Kinds, States (every confidence × every state), and a small diagram in plain, Trace, and Diff modes.
- **Geometry:** drawn from route points (ELK's in M4b). Bends are rounded (radius 10, less on short jogs); the line stops at the arrowhead's base.
- **Line style = confidence:** solid (exact); solid with a small dot just off the source (pattern); dashed 6/4 (heuristic); dotted, with an open chevron arrowhead (unresolved). Arrowheads are filled 8×8 triangles otherwise.
- **Color:** the source's layer, 70% mixed into `--text-muted` at rest (≥ 3:1 on every surface, tested), full layer color and 2px on hover.
- **Labels:** a quiet pill on the line's midpoint: `POST /api/orders · HTTP` (method chip, mono path, muted protocol), `reads id, total`, "calls API" (never a guessed protocol), the reason in words when unresolved (dotted pill), "22 calls" for aggregated edges.
- **States** (combine; color goes to broken > selected > traced > diff > hover):
  - **Selected:** accent line plus a soft accent halo; accent pill border.
  - **Traced:** trace-colored 2.5px line with a trace halo; trace pill border.
  - **Dimmed:** 20% opacity (50% on hover), label too.
  - **Diff:** line in the diff color; the pill leads with "Added", "Changed", or "Removed". Removed is ghosted to 50% and its label struck through.
  - **Broken:** pulsing red dashes whatever the confidence, and the pill says what broke ("Route removed in this PR").
- **Flow:** two particles per edge travel source to target (a canvas ring keeps them visible on a same-colored line). Reduced motion removes them and stops the broken pulse.

**Icons** (implemented in M4a.3, `packages/viewer/src/icons/`; approved at the design gate, changes in §1.1; ADR-0048)
- **Brand logos:** from Simple Icons 16.36 (CC0 icons; trademarks belong to their owners and are used only to identify the technology). Mapped only from the node's own field: `service.framework`, `datastore.engine` / `queue.engine`, and `external.host` (which covers the SDK hosts). A host matches its suffix at a label boundary, and the longest suffix wins (`maps.googleapis.com` is Google Maps). The tables are in `brands.ts`; story **Foundations/Icons → Logos** shows all of them.
  - **No logo, so the kind's glyph:** brands Simple Icons doesn't ship (OpenAI, AWS, Microsoft SQL Server, Twilio, Slack, SendGrid, Postmark, Memcached, Typesense, Redpanda), unknown hosts, IPs, and loopback. Never a guessed logo.
  - **Tile:** logos and glyphs sit on a neutral rounded tile, always `--surface-1` with a hairline: `sm` 32px (radius 6, 20px icon) for card rows, `lg` 56px (radius 12, 32px icon) for icon-first nodes. Node states restyle the node, never the tile.
  - **Layer ring:** the tile's hairline mixes 60% of the layer color into `--border`, a tint, not a stroke that outshines the logo.
  - **Color:** the official brand color when it is at least 3:1 on the tile in that theme, otherwise `--text` (monochrome). Black marks (Next.js, Vercel, X) are black in light and text-colored in dark; pale ones (ClickHouse, Hugging Face) go monochrome in light. Both fills are set on the element and the theme picks one in CSS, so switching themes re-renders nothing.
  - **Optical size:** logos are inset 3px on a 30px box (80% of the icon size), so filled marks match the stroked glyphs.
- **Custom glyph set** for generic kinds: drawn on a 24px grid with 1.5px `currentColor` strokes, round caps and joins, no fills, about 3.75px margins, and designed as a family (`glyphs.tsx`, story **Foundations/Icons → Glyphs**):
  - Service fallback: a two-unit server.
  - Module: a folder. File: a page with a folded corner and two lines.
  - Function: ƒ. Method: ƒ in a rounded frame. Class: an open box. Variable: braces around a dot.
  - Route: a request arriving at an endpoint (dot, line, arrowhead). Page: a browser window.
  - Model: a table with a header row. Datastore (engine without a logo): a cylinder.
  - Queue: messages in a pipe. Unknown external: a globe.
  - Unresolved: a question mark in a dotted ring, echoing the dotted line of unresolved edges.

## 4. Tokens (implemented in M4a.2; approved at the design gate, changes in §1.1)

Source of truth: `packages/viewer/src/tokens.ts` and `src/styles/tokens.css`, which a test keeps identical (ADR-0047). The Storybook story **Foundations/Tokens** shows every value in both themes.

**Color**

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--canvas` | `#0b0e14` | `#f5f7fa` | diagram background (solid; depth comes from container tints, not patterns) |
| `--surface-1` | `#12161f` | `#ffffff` | cards, inspector |
| `--surface-2` | `#181e2a` | `#edf0f5` | hover, nested surfaces |
| `--surface-raised` | `#1c2332` | `#ffffff` | popovers, palette (elevation 2–3) |
| `--border` | `#252c3a` | `#d9dee7` | hairlines |
| `--text` | `#e8ecf4` | `#121722` | primary text |
| `--text-muted` | `#8e97ab` | `#556073` | secondary text |
| `--accent` | `#8db0ff` | `#2f5fd0` | selection, focus |
| `--layer-frontend` | `#79a6ff` | `#2e6be6` | |
| `--layer-backend` | `#b794f6` | `#7a4fd1` | |
| `--layer-data` | `#34d3a6` | `#0e8a6a` | |
| `--layer-infra` | `#f0a35e` | `#b8641c` | |
| `--layer-external` | `#f38bc4` | `#c0418a` | |
| `--trace` | `#ffd37a` | `#a66f00` | trace highlight and pulse |
| `--diff-added` | `#4ade80` | `#1e8e4e` | diff mode only |
| `--diff-changed` | `#f5c451` | `#a87700` | diff mode only |
| `--diff-removed` | `#ff6b6b` | `#d23b3b` | diff mode only |
| `--scrim` | `rgba(5, 7, 11, 0.6)` | `rgba(18, 23, 34, 0.32)` | backdrop dim behind the palette |

**Contrast (enforced by tests, both themes, on the canvas and every surface):** `--text` and `--text-muted` are at least 4.5:1, so they're the only text colors. Accent, layer, trace, and diff colors are at least 3:1: use them for strokes, rings, icons, and focus, never for small text. The light theme keeps each dark hue and lowers its lightness until it clears that bar; it's never a plain inversion.

**Type**
- UI and body: **Geist**. Chosen to match the Vercel reference, with crisp numerals and good small sizes. Self-hosted from the Fontsource packages; the app's bundler serves the woff2 files from our own origin (ADR-0047).
- Code and identifiers: **Geist Mono**, used only for code, paths, and routes, never for general labels.
- Scale (px): 12 / 13 / 14 / 16 / 20 / 28. Weights 400 / 500 / 600.
- `font-variant-numeric: tabular-nums` for counts.

**Spacing:** 4px base: 4, 8, 12, 16, 24, 32, 48.

**Radius by hierarchy** (not one radius everywhere):
- Service frame 16.
- Module frame 12.
- Card 10.
- Icon tile 12.
- Chip 6.
- Pill: full.

**Elevation:**
- 0: canvas.
- 1: cards (border only, no shadow).
- 2: popovers and inspector overlays (`--surface-raised` + `--shadow-2`).
- 3: command palette (`--surface-raised` + `--shadow-3` + `--scrim`).
- Shadows barely show on the dark canvas, so the raised fill does most of the lifting there.

**Motion:**
- Fast (120ms) for hover and focus.
- Standard (240ms) for panels.
- Layout (600ms, ease-in-out cubic) for drill-down glides.
- Trace hop (900ms).
- One orchestrated moment on first load: services settle into place.
- `prefers-reduced-motion` makes every transition instant and turns off flow particles. The stylesheet sets every `--duration-*` to `0ms`; JS animation reads `durations` from `tokens.ts` and must check the same media query.
- Easing: `--ease-standard` `cubic-bezier(0.2, 0, 0, 1)` for hover and panels, `--ease-layout` `cubic-bezier(0.65, 0, 0.35, 1)` (ease-in-out cubic) for glides.

**Chrome** (implemented in M4a.6, `packages/viewer/src/chrome/`; approved at the design gate, changes in §1.1; ADR-0051). Story **Components/Chrome** shows Controls, Top bar, Inspector, Canvas overlays, Command palette (with and without results), and Layout (everything around a small diagram).
- **Controls:**
  - **Buttons:** `primary` (accent fill, canvas-colored text, ≥ 4.5:1 tested) for the one main action on a surface, `secondary` (`surface-1` + hairline), `quiet` (muted text, `surface-2` on hover) for toolbars. 32px in the top bar, 28px in overlays and the inspector, radius 6. A shortcut hint sits inside the button as key caps.
  - **Switch** (`role="switch"`), **segmented control** (a radio group: one tab stop, arrow keys move), **key caps** (Geist, not mono: keys aren't code), **chips** (kind, layer with a dot, commit), **counts**.
  - **Interface icons:** 14 icons on the glyphs' 24 grid with round caps and no fills, but a 2-unit stroke (1.33px at 16px), because the glyphs' 1.5 drew hairlines next to 13px text.
- **Top bar** (52px, `surface-1`): the mark and "GitInside", the repo (owner muted) and a chip with the branch and short SHA (full SHA in the tooltip), a centered search field that opens the palette (Ctrl K or ⌘ K), then Base / Head / Overlay when there is a base, Filters (with a count), Share, and **Trace a request**, the only primary button (it becomes a secondary "Exit trace" while tracing). The repo name and actions never shrink; search gives way.
- **Canvas overlays** (`surface-1`, hairline, `shadow-2`, radius 10): status chips top-left (a trace gets a pulsing trace-colored dot, a diff the compare icon, since trace and diff-changed are both amber), zoom − / level / + / fit top-right, the drill-down path bottom-left (files and symbols in mono), the minimap (boxes tinted by layer, the view in an accent frame) and a "Legend" button bottom-right.
- **Legend** (popover, `surface-raised` + `shadow-2`, two columns so it opens over a laptop-height canvas): layer swatches, the four line styles drawn by `DiagramEdge` itself, shapes by tier, and the highlight states in words. Built from the same tables the canvas uses.
- **Inspector** (`surface-1`, left hairline): kind and layer chips, icon and name (the panel's heading), where it lives; the "From the code" sentence on `surface-2`; sections for facts (long values truncate, the tooltip has them), **Called by** and **Calls** (each row: icon, name, the edge's words and confidence, a short line in the edge's style), the code with line numbers and the selected line marked, "Open on GitHub" at the commit permalink; actions at the foot.
- **Command palette** (elevation 3: `surface-raised`, `shadow-3`, scrim): a 16px field, results with icon, name (matched characters tinted), path in mono, and kind on the right; the active row is accent-tinted; an empty state that suggests what to try; a key-hint footer.

## 5. Accessibility floor

- WCAG 2.2 AA contrast for text and essential graphics in both themes.
- Visible focus rings (`--accent`, 2px, offset).
- Color is never the only signal: confidence also uses line style, diff state also uses badges and text.
- Keyboard navigation of the graph and screen-reader text are specified in UX.md.

## 6. Review checklist (every UI task)

Take Playwright screenshots in dark and light, then check:
1. Does the screenshot read as a system design diagram at a glance?
2. Are logos and icons crisp and consistent?
3. Is anything from §2 present?
4. Does every visual device map to §3?
5. Contrast, focus, and reduced motion OK?

Fix before committing.
