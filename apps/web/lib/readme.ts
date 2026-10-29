/**
 * The Markdown the repo page's "Add to README" offers (UX.md "README badge", ADR-0073), apart
 * from React so tests check the exact text. Both snippets link to the repo page (never a
 * permalink: a README shows the latest commit) and use the image routes of ADR-0072.
 *
 * - **Badge:** one Markdown line, `[![…](…/api/badge/<owner>/<repo>.svg)](…/<owner>/<repo>)`.
 * - **Live image:** HTML, because Markdown has no `<picture>`. GitHub renders a README image
 *   through its proxy as an `<img>`, where the SVG's own `prefers-color-scheme` follows the
 *   reader's system, not their GitHub theme. `<picture>` with a `media` source is what GitHub
 *   documents for theme-aware images, so each theme asks for its own `?theme=`.
 *
 * Owner and repo come from the database in GitHub's spelling (letters, digits, `-`, `_`, `.`),
 * but they are still encoded for the URL and escaped for the HTML, so a bad row can't break
 * out of an attribute.
 */

/** Which snippet: the small badge or the full live image. */
export type ReadmeKind = "badge" | "image";

/** `encodeURIComponent`, plus the characters it leaves alone that Markdown or HTML would read. */
function encodeSegment(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The image URLs and the repo page of one repo on `origin` (e.g. `https://gitinside.abhinavgonthina.dev`). */
export function readmeUrls(origin: string, owner: string, repo: string) {
  const path = `${encodeSegment(owner)}/${encodeSegment(repo)}`;
  return {
    page: `${origin}/${path}`,
    badge: `${origin}/api/badge/${path}.svg`,
    diagram: (theme: "dark" | "light") => `${origin}/api/diagram/${path}.svg?theme=${theme}`,
  };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** The alt text of both images, which is also what a screen reader says in the README. */
export function readmeAlt(owner: string, repo: string): string {
  return `Architecture of ${owner}/${repo}, by GitInside`;
}

/** The snippet of `kind` for one repo, ending in a newline so it pastes as its own block. */
export function readmeMarkdown(
  kind: ReadmeKind,
  origin: string,
  owner: string,
  repo: string,
): string {
  const urls = readmeUrls(origin, owner, repo);
  const alt = readmeAlt(owner, repo);
  if (kind === "badge") {
    // Markdown alt text ends at `]`, and a `\` before it would escape it.
    return `[![${alt.replace(/[\\[\]]/g, "")}](${urls.badge})](${urls.page})\n`;
  }
  return [
    `<a href="${escapeHtml(urls.page)}">`,
    "  <picture>",
    `    <source media="(prefers-color-scheme: dark)" srcset="${escapeHtml(urls.diagram("dark"))}">`,
    `    <img alt="${escapeHtml(alt)}" src="${escapeHtml(urls.diagram("light"))}">`,
    "  </picture>",
    "</a>",
    "",
  ].join("\n");
}
