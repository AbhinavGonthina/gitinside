import { BASE_PARAM, STATE_PARAMS, withState, type IgnoredParam } from "@gitinside/viewer";
import type { SearchParams } from "./compare";
import { short } from "./repoStatus";

/** The parameters a deep link is made of: diff mode's base, then the explorer's state. */
const DEEP_LINK_PARAMS: readonly string[] = [BASE_PARAM, ...STATE_PARAMS];

/**
 * The deep-link part of a page's query (F3, M9.7b), as a query string without `?` (empty when
 * there's none): only {@link DEEP_LINK_PARAMS}, in that order, each value of a repeated one in
 * order, so a demo pin's detour through its progress page comes back to the same view. Next
 * hands the page decoded values, so each is escaped again, keeping `,` (the explorer's list
 * separator) and `/`, `:`, `@` (readable node IDs) as they are.
 */
export function deepLinkQuery(query: SearchParams): string {
  const escape = (value: string) =>
    encodeURIComponent(value).replace(/%(2C|2F|3A|40)/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  const parts: string[] = [];
  for (const param of DEEP_LINK_PARAMS) {
    const value = Object.hasOwn(query, param) ? query[param] : undefined;
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined) parts.push(`${param}=${escape(one)}`);
    }
  }
  return parts.join("&");
}

/**
 * The link "Copy link" gives (UX.md "Deep links"): this commit's permalink with the
 * explorer's state, so the link keeps opening the same diagram after newer commits are
 * analyzed (node IDs can change between commits).
 */
export function shareUrl(
  origin: string,
  owner: string,
  repo: string,
  sha: string,
  query: string,
): string {
  return withState(`${origin}/${owner}/${repo}/${sha}`, query);
}

/** How the note names each part of a link (`decodeState`'s parameters). */
const PARAM_WORDS: Readonly<Record<string, string>> = {
  view: "diff view",
  open: "broken down",
  sel: "selected",
  trace: "traced from",
  step: "step",
  hideLayers: "hidden layer",
  hideKinds: "hidden kind",
  hideConfidence: "hidden confidence",
  hideLines: "hidden connections",
  only: "only the folder",
  hideFolders: "hidden folder",
  tests: "tests",
};

/** At most this many left-out parts are named; the rest are counted. */
export const IGNORED_NAMED = 3;

/**
 * The note for a link that doesn't fully apply to this commit (fail visibly, ADR-0122):
 * what was left out, in the link's order, e.g. "Part of this link doesn't apply to commit
 * a1b2c3d, so it was left out: selected route:api/GET /old; step 9." Undefined when all of
 * it applied.
 */
export function ignoredNote(ignored: readonly IgnoredParam[], sha: string): string | undefined {
  if (ignored.length === 0) return undefined;
  const named = ignored
    .slice(0, IGNORED_NAMED)
    .map(({ param, value }) => `${PARAM_WORDS[param] ?? param} ${value}`);
  const more = ignored.length - named.length;
  const list = more > 0 ? `${named.join("; ")}; and ${more} more` : named.join("; ");
  return `Part of this link doesn't apply to commit ${short(sha)}, so it was left out: ${list}.`;
}
