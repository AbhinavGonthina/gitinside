/** Longest error text kept in a warning. */
const MAX_ERROR_TEXT = 200;

/**
 * An internal error as text for a graph warning: its name and message (stack traces aren't
 * kept: they hold machine paths and change between builds), with the checkout's path `root`
 * removed in either slash style so the graph is the same on every machine, cut to 200
 * characters.
 */
export function errorText(error: unknown, root: string): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const prefix of new Set([root, root.replaceAll("\\", "/")])) {
    if (prefix === "") continue;
    text = text.replaceAll(`${prefix}/`, "").replaceAll(`${prefix}\\`, "").replaceAll(prefix, ".");
  }
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text;
}
