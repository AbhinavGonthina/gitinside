# Design system

**Status:** starting brief. M4a turns this into tokens and components, then Abhinav approves the result at the design gate (ADR-0017). Update this file with every approved change. Decisions: D6.1–D6.4.

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

**Icons** (implemented in M4a.3, `packages/viewer/src/icons/`; pending the design gate; ADR-0048)
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

## 4. Tokens (implemented in M4a.2; pending the design gate)

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
