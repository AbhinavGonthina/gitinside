import type { GraphRepo } from "@gitinside/schema";
import type { Shown } from "../explorer/transition.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import type { Theme } from "../ViewerRoot.js";
import { viewMermaid } from "./mermaid.js";
import { renderViewSvg } from "./svg.js";

/**
 * Turning the view on screen into files (M4b.10b, UX.md "Export"): the SVG
 * and Mermaid text from the pure renderers, the PNG rasterized from the SVG
 * in the browser, and a download that never leaves the page. Nothing is
 * uploaded: every file is made and saved on the reader's machine.
 */

/** How much bigger than the SVG a PNG is drawn, so it stays sharp on high-density screens. */
export const PNG_SCALE = 2;

/** The largest canvas side browsers draw reliably (Chrome, Firefox, and Safari all allow at least this). */
export const MAX_CANVAS_SIDE = 16_384;

/** The largest canvas area Safari draws (16.7 million pixels); Chrome and Firefox allow more. */
export const MAX_CANVAS_AREA = 16_777_216;

/** What the share menu exports: the view on screen, ready to render in either theme. */
export interface ViewExport {
  /** The file name without its extension, e.g. `acme-shop-a1b2c3d`. */
  name: string;
  /** The view as a standalone SVG document in a theme (`renderViewSvg`). */
  svg(theme: Theme): string;
  /** The view as a Mermaid `flowchart` (`viewMermaid`). */
  mermaid(): string;
}

/**
 * The view as drawn (its view and the layout it was drawn at) as a
 * {@link ViewExport}. Each file is rendered when asked for, so a view that's
 * never exported costs nothing.
 */
export function viewExport(index: HierarchyIndex, shown: Shown): ViewExport {
  return {
    name: exportName(index.graph.repo),
    svg: (theme) => renderViewSvg(index, shown.view, shown.layout, { theme }),
    mermaid: () => viewMermaid(index, shown.view),
  };
}

/**
 * A file name for a repo's export: owner, name, and the commit's first 7
 * characters, e.g. `acme-shop-a1b2c3d`. Anything but letters, digits, `.`,
 * `_`, and `-` becomes `-`, so a repo's name can't add a folder or an
 * extension.
 */
export function exportName(repo: GraphRepo): string {
  const parts = [repo.owner, repo.name, repo.sha ? repo.sha.slice(0, 7) : ""];
  const name = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return name || "gitinside";
}

/**
 * The scale a PNG of a `width` × `height` SVG is drawn at: {@link PNG_SCALE},
 * or less when that would pass a browser's canvas limits (a very large view),
 * never more.
 */
export function pngScale(width: number, height: number): number {
  const side = MAX_CANVAS_SIDE / Math.max(width, height, 1);
  const area = Math.sqrt(MAX_CANVAS_AREA / Math.max(width * height, 1));
  return Math.min(PNG_SCALE, side, area);
}

/** A PNG made from an SVG, and the scale it was drawn at. */
export interface Png {
  blob: Blob;
  scale: number;
}

/**
 * Rasterizes an SVG document to a PNG in the browser, at {@link pngScale}:
 * the SVG is loaded as an image from a `blob:` URL (the website's CSP allows
 * `img-src blob:`), drawn onto a canvas, and encoded. An SVG image can't load
 * fonts, so text uses the system's sans and mono, as the SVG file does where
 * Geist isn't installed.
 */
export async function svgToPng(svg: string): Promise<Png> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = pngScale(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(image.naturalWidth * scale);
    canvas.height = Math.floor(image.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The canvas made no PNG");
    return { blob, scale };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How long a download's `blob:` URL stays alive: long enough for any browser to start saving. */
const REVOKE_AFTER_MS = 60_000;

/**
 * Saves a file to the reader's machine: a `download` link to a `blob:` URL,
 * clicked and removed at once. The URL is revoked a minute later (revoking it
 * right after the click cancels the download in some browsers).
 */
export function saveFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
