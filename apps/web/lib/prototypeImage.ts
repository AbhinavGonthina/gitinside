import { parseGraph } from "@gitinside/schema";
import { renderDiagram } from "@gitinside/viewer/image";
import { IMAGE_CSP } from "./csp";
import { imageTheme } from "./imageRoute";
import { findPrototypeRepo, upstreamGraphUrl } from "./prototype";
import { httpsGet, PROTOTYPE_GRAPH_CACHE_CONTROL, type UpstreamGet } from "./prototypeGraph";
import type { PrototypeRepo } from "./prototypeLinks";

/**
 * `GET /api/prototype/diagram/:owner/:repo[?theme=dark|light]` (M10.3e2a, M10-design §3.5): the
 * prototype landing's gallery image of one of its repos, a crop of the README image at 100%
 * around the repo's hub (`renderDiagram`'s `crop`), so the card's names read instead of shrinking
 * the whole diagram into it. Like the graph proxy (`prototypeGraph.ts`), it reads production's
 * stored graph from one fixed host for a fixed list of repos, so a preview without a database
 * draws the same cards, and nothing else can be asked for.
 */

/**
 * The narrowest viewport (CSS px) with the gallery's three columns (globals.css); below it, one
 * card per row.
 */
export const GALLERY_COLUMNS_FROM = 1101;

/** The card thumbnail's height in CSS px (globals.css `.landing[data-prototype] .demo__thumb`). */
export const GALLERY_THUMB_HEIGHT = 280;

/**
 * The crop: wider than a card's thumbnail at any width the gallery takes (one card per row is at
 * most 1100 − 48px wide) and taller than {@link GALLERY_THUMB_HEIGHT}, with room for the hover's
 * 4px pan, so no edge shows. The SVG holds the whole drawing whatever the crop (only its
 * `viewBox` changes), so a wide one costs nothing. `focus` fits the narrowest three-column
 * thumbnail (at {@link GALLERY_COLUMNS_FROM}: 333px inside its border) with a margin, so a wide hub
 * shows its icon and name from its left edge.
 */
export const GALLERY_CROP = { width: 1104, height: 304, focus: 320 } as const;

/** Where a card's image is drawn, in one theme. */
export function prototypeImageUrl(repo: PrototypeRepo, theme: "dark" | "light"): string {
  return `/api/prototype/diagram/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}?theme=${theme}`;
}

const failed = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * The route's answer: the cropped SVG (cached as the graph proxy's answers are: each repo's
 * commit is fixed), a 404 for a repo the prototype doesn't draw (before anything is fetched), or a
 * 502 when production doesn't serve the graph or it isn't a valid one. The SVG keeps the README
 * image's own CSP, since opened directly it's a document on our origin.
 */
export async function handlePrototypeImage(
  params: { owner: string; repo: string },
  theme: string | null,
  get: UpstreamGet = httpsGet,
): Promise<Response> {
  const repo = findPrototypeRepo(params.owner, params.repo);
  if (repo === undefined) return failed(404, "The prototype doesn't draw this repo.");
  try {
    const upstream = await get(upstreamGraphUrl(repo));
    if (upstream.status !== 200) {
      await upstream.body.cancel();
      return failed(502, `The site's stored graph answered ${upstream.status}.`);
    }
    const body =
      upstream.encoding === "gzip"
        ? upstream.body.pipeThrough(new DecompressionStream("gzip"))
        : upstream.body;
    const graph = parseGraph(JSON.parse(await new Response(body).text()));
    const svg = renderDiagram(graph, { theme: imageTheme(theme), crop: GALLERY_CROP });
    return new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": PROTOTYPE_GRAPH_CACHE_CONTROL,
        "content-security-policy": IMAGE_CSP,
        "x-robots-tag": "noindex",
      },
    });
  } catch (error) {
    // By name only, as the image routes log: a message can carry connection details.
    console.error(
      JSON.stringify({
        event: "prototype_image_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return failed(502, "Couldn't draw the site's stored graph.");
  }
}
