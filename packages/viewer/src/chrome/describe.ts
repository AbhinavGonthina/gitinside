import type { Layer } from "@gitinside/schema";

/**
 * Pure helpers for the explorer chrome (UX.md "Layout"): words for layers,
 * commit links, the minimap's fit, and search-match highlighting. Like the
 * node and edge helpers, nothing here guesses: every string comes from the
 * graph or the caller.
 */

/** Layers in words, for chips, the legend, and the inspector. */
export const LAYER_NAMES: Readonly<Record<Layer, string>> = {
  frontend: "Frontend",
  backend: "Backend",
  data: "Data",
  infra: "Infrastructure",
  external: "External",
};

/** The repo a diagram was built from, as the graph records it (`graph.repo`). */
export interface RepoRef {
  owner: string;
  name: string;
  sha?: string | undefined;
}

/** A commit SHA as shown in chips: the first 7 characters, like GitHub. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A file at a commit as URL path pieces, each segment encoded. */
export interface RepoFileParts {
  /** `owner/name`. */
  repo: string;
  /** The commit SHA. */
  sha: string;
  /** The repo-relative path. */
  path: string;
}

/**
 * A file at the analyzed commit as encoded URL path pieces, for GitHub links
 * and raw file reads. `encodeURIComponent` leaves `.` and `..` as they are,
 * and URLs resolve those, so a graph path like `../../other/repo/a.ts` would
 * point into another repo; such segments (and empty ones, as in `a//b` or a
 * leading `/`) anywhere in the owner, name, SHA, or path give undefined, as
 * does a missing SHA. Our analyzer never writes them, but a graph is data
 * and isn't trusted here.
 */
export function repoFileParts(repo: RepoRef, path: string): RepoFileParts | undefined {
  if (!repo.sha) return undefined;
  const file = path.split("/");
  const segments = [repo.owner, repo.name, repo.sha, ...file];
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return {
    repo: `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    sha: encodeURIComponent(repo.sha),
    path: file.map(encodeURIComponent).join("/"),
  };
}

/**
 * A permalink to a file at the analyzed commit, at a line when given
 * (UX.md "Open on GitHub at the exact line"). Each path segment is encoded,
 * so spaces and `#` in file names can't break the link. Without a SHA there
 * is no permalink, so this returns undefined rather than linking a branch
 * that may have moved; likewise for a path that could leave the repo
 * ({@link repoFileParts}).
 */
export function githubLineUrl(repo: RepoRef, path: string, line?: number): string | undefined {
  const parts = repoFileParts(repo, path);
  if (!parts) return undefined;
  return `https://github.com/${parts.repo}/blob/${parts.sha}/${parts.path}${line ? `#L${line}` : ""}`;
}

/** Zoom as a percentage for the zoom controls: 0.754 ⇒ "75%". */
export function zoomText(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** An axis-aligned box in canvas coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How canvas coordinates map into the minimap: `mini = canvas * scale + offset`. */
export interface MinimapFit {
  scale: number;
  dx: number;
  dy: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The transform that fits `content` (the diagram's bounds) inside a box of
 * the given size with `padding` on every side, centered, keeping its aspect
 * ratio. A zero-size side counts as 1 so a single point still fits.
 */
export function minimapFit(
  content: Rect,
  box: { width: number; height: number },
  padding = 8,
): MinimapFit {
  const innerW = Math.max(box.width - 2 * padding, 1);
  const innerH = Math.max(box.height - 2 * padding, 1);
  const w = Math.max(content.width, 1);
  const h = Math.max(content.height, 1);
  const scale = Math.min(innerW / w, innerH / h);
  return {
    scale: round(scale),
    dx: round(padding + (innerW - w * scale) / 2 - content.x * scale),
    dy: round(padding + (innerH - h * scale) / 2 - content.y * scale),
  };
}

/** A canvas box in minimap coordinates, rounded to 0.01px so the SVG text is stable. */
export function toMinimap(rect: Rect, fit: MinimapFit): Rect {
  return {
    x: round(rect.x * fit.scale + fit.dx),
    y: round(rect.y * fit.scale + fit.dy),
    width: round(rect.width * fit.scale),
    height: round(rect.height * fit.scale),
  };
}

/** The smallest box holding every given box, or undefined for none. */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A run of text that did or didn't match the search query. */
export interface TextSegment {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into matched and unmatched runs for the command palette.
 * `ranges` are `[start, end)` character offsets from the fuzzy matcher, in
 * any order; they are clamped to the text, and overlapping or touching ranges
 * merge, so the output alternates and never has empty runs.
 */
export function highlightSegments(
  text: string,
  ranges: readonly (readonly [number, number])[] = [],
): TextSegment[] {
  const sorted = ranges
    .map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)] as const)
    .filter(([a, b]) => a < b)
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const out: TextSegment[] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: text.slice(at, a), match: false });
    out.push({ text: text.slice(a, b), match: true });
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}
