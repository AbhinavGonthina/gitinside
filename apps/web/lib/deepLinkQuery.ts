import type { SearchParams } from "./compare";

/**
 * The parameters a deep link is made of: diff mode's base, then the explorer's state, in the
 * viewer's order (`BASE_PARAM`, `STATE_PARAMS`). Written out here because server pages can't
 * read values from `@gitinside/viewer` (a client module: its exports are client references
 * there); `deepLinkQuery.test.ts` checks the list against the viewer's.
 */
export const DEEP_LINK_PARAMS: readonly string[] = [
  "base",
  "view",
  "open",
  "sel",
  "trace",
  "step",
  "hideLayers",
  "hideKinds",
  "hideConfidence",
  "hideLines",
  "only",
  "hideFolders",
  "tests",
];

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
