import { compareStrings, type GraphNode, type NodeKind } from "@gitinside/schema";
import { useMemo, useState } from "react";
import { CommandPalette, type PaletteResult } from "../chrome/CommandPalette.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";

/**
 * The command palette's search (M4b.7, UX.md "Search: command palette"): a
 * fuzzy match over every node but the system, by name first and where it
 * lives second. Ranking is deterministic: the same graph and query always
 * list the same results in the same order.
 *
 * Each word of the query must match, in any case, either in the name (whole,
 * at its start, at a word start, anywhere, or as letters in order with gaps)
 * or in the path. Patterns it doesn't handle: typos (a letter missing or
 * swapped matches nothing), and matching a word across the name and the path.
 */

/** Ties go to the kinds people look for most: services and entry points before code. */
const KIND_ORDER: readonly NodeKind[] = [
  "service",
  "page",
  "route",
  "model",
  "module",
  "file",
  "symbol",
  "datastore",
  "queue",
  "external",
  "unresolved",
  "system",
];

/** At most this many results are listed; the field narrows the rest. */
export const SEARCH_LIMIT = 50;

/** A node the palette can find, with the text a query is matched against. */
export interface SearchEntry {
  result: PaletteResult;
  /** The name, lowercased. */
  name: string;
  /** Where it lives (`result.path`), lowercased; empty without one. */
  where: string;
  /** Position in {@link KIND_ORDER}. */
  kindRank: number;
}

/**
 * Where a node lives, shown muted beside its name: a service's root, a
 * folder's or file's path, an outside API's host when its name isn't the
 * host, else the file it's defined in.
 */
export function nodeWhere(node: GraphNode): string | undefined {
  switch (node.kind) {
    case "service":
      return node.root || undefined;
    case "module":
      return node.path || undefined;
    case "file":
      return node.path;
    case "external":
      return node.host !== node.label ? node.host : node.source?.file;
    default:
      return "source" in node ? node.source?.file : undefined;
  }
}

/** Every node but the system, in graph order. */
export function searchEntries(index: HierarchyIndex): SearchEntry[] {
  return index.graph.nodes
    .filter((n) => n.id !== index.root.id && n.kind !== "system")
    .map((node) => {
      const path = nodeWhere(node);
      return {
        result: { node, layer: layerOf(index, node.id), path },
        name: node.label.toLowerCase(),
        where: path?.toLowerCase() ?? "",
        kindRank: KIND_ORDER.indexOf(node.kind),
      };
    });
}

/** Whether a word starts at `i` in `label`: its start, after a non-letter-or-digit, or a camelCase step. */
function isWordStart(label: string, i: number): boolean {
  if (i === 0) return true;
  const prev = label.charAt(i - 1);
  const here = label.charAt(i);
  if (!/[\p{L}\p{N}]/u.test(prev)) return true;
  return /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(here);
}

type Ranges = [number, number][];

/** One word against a name: its score and the characters it marked, or undefined. */
function matchName(
  label: string,
  name: string,
  word: string,
): { score: number; ranges: Ranges } | undefined {
  const first = name.indexOf(word);
  if (first >= 0) {
    // Prefer an occurrence at a word start ("orders" in "listOrders").
    let at = first;
    for (let i = first; i >= 0; i = name.indexOf(word, i + 1)) {
      if (isWordStart(label, i)) {
        at = i;
        break;
      }
    }
    const score =
      word.length === name.length ? 100 : at === 0 ? 80 : isWordStart(label, at) ? 60 : 40;
    return { score, ranges: [[at, at + word.length]] };
  }
  // Its letters in order with gaps ("plord" in "placeOrder"): weaker the more it skips.
  if (word.length < 2) return undefined;
  const ranges: Ranges = [];
  let from = 0;
  let skipped = 0;
  for (const ch of word) {
    const j = name.indexOf(ch, from);
    if (j < 0) return undefined;
    const last = ranges.at(-1);
    if (last && last[1] === j) last[1] = j + 1;
    else {
      if (last) skipped += j - last[1];
      ranges.push([j, j + 1]);
    }
    from = j + 1;
  }
  return { score: Math.max(1, 20 - skipped), ranges };
}

/** A word found only in the path scores below any match in the name. */
const PATH_SCORE = 10;

/**
 * The nodes matching `query`, best first, at most {@link SEARCH_LIMIT}. An
 * empty query lists nothing (the palette says what to type). Ties go by kind
 * ({@link KIND_ORDER}), then the shorter name, then name and ID.
 */
export function searchNodes(entries: readonly SearchEntry[], query: string): PaletteResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found: { entry: SearchEntry; score: number; ranges: Ranges }[] = [];
  for (const entry of entries) {
    let score = 0;
    const ranges: Ranges = [];
    for (const word of words) {
      const inName = matchName(entry.result.node.label, entry.name, word);
      if (inName) {
        score += inName.score;
        ranges.push(...inName.ranges);
      } else if (entry.where.includes(word)) score += PATH_SCORE;
      else {
        score = -1;
        break;
      }
    }
    if (score >= 0) found.push({ entry, score, ranges });
  }
  found.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.kindRank - b.entry.kindRank ||
      a.entry.name.length - b.entry.name.length ||
      compareStrings(a.entry.result.node.label, b.entry.result.node.label) ||
      compareStrings(a.entry.result.node.id, b.entry.result.node.id),
  );
  return found
    .slice(0, SEARCH_LIMIT)
    .map(({ entry, ranges }) =>
      ranges.length > 0 ? { ...entry.result, matches: ranges } : entry.result,
    );
}

/** Props for {@link SearchPalette}. */
export interface SearchPaletteProps {
  entries: readonly SearchEntry[];
  /** `"closing"` while it plays its exit (`usePresence`). */
  state: "open" | "closing";
  onPick: (id: string) => void;
  onClose: () => void;
}

/** The Ctrl+K palette: the shell, holding its own query and active row. */
export function SearchPalette({ entries, state, onPick, onClose }: SearchPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchNodes(entries, query), [entries, query]);
  return (
    <CommandPalette
      autoFocus
      state={state}
      query={query}
      results={results}
      activeIndex={active}
      onQueryChange={(q) => {
        setQuery(q);
        setActive(0);
      }}
      onActiveIndexChange={setActive}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
