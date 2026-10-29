// The README images (M5.9) as text: no CSS, no React rendering, and no
// "use client" banner, so server code (apps/web's route handlers) can call
// them (`@gitinside/viewer/image`). The main entry is client code.
export { BADGE_COLORS, BADGE_HEIGHT, renderBadge } from "./image/badge.js";
export type { BadgeOptions, BadgeTone } from "./image/badge.js";
export { MAX_ROWS, renderDiagram, topLevelCounts } from "./image/diagram.js";
export type { DiagramImageOptions } from "./image/diagram.js";
export type { ImageTheme } from "./image/palette.js";
