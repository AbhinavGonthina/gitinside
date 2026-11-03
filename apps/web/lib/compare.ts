import { diffGraphs, IncompatibleGraphsError } from "@gitinside/diff";
import type { ArchitectureGraph, GraphDiff } from "@gitinside/schema";
import { short } from "./repoStatus";

/**
 * Diff mode on the website (M6.9e2, ADR-0189): what the diagram page compares its commit
 * with, from the link's `?base=<sha>`. The server says whether that commit has a published
 * analysis (`viewBase`); the browser loads both graphs and diffs them here. No server
 * imports, so the page's client components can use it.
 */

/** What a link's `base` names, as the server found it. */
export type BaseView =
  /** A commit with a published analysis of this repo, and where its graph is. */
  | { status: "ready"; sha: string; graphUrl: string }
  /** A full SHA nobody analyzed (or whose analysis was pruned). */
  | { status: "missing"; sha: string }
  /** Not a full, lowercase, 40-character SHA. */
  | { status: "invalid" };

/**
 * The query parameter, as the explorer's codec names it (`BASE_PARAM` in `@gitinside/viewer`,
 * which server components don't import; a test keeps the two equal).
 */
export const BASE_PARAM = "base";

/** The base commit's full SHA, as permalinks and the API take it. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** A page's query, as Next.js gives it to the page. */
export type SearchParams = Record<string, string | string[] | undefined>;

/** The link's `base` from the page's query: the last of a repeated one, like the explorer's codec. */
export function baseParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

/** Two graphs compared, or why they can't be, said as a note above the head's diagram. */
export type Comparison =
  | { ok: true; base: ArchitectureGraph; diff: GraphDiff }
  | { ok: false; note: string };

/**
 * Diffs `base` against `head` (`diffGraphs`, without file contents: a moved file pairs
 * only when its content is unchanged, ADR-0086, ADR-0189). Graphs from two analyzer versions aren't
 * compared, since every difference the analyzer made would read as a change in the code;
 * the note says so instead.
 */
export function compareGraphs(base: ArchitectureGraph, head: ArchitectureGraph): Comparison {
  try {
    return { ok: true, base, diff: diffGraphs(base, head) };
  } catch (error) {
    if (!(error instanceof IncompatibleGraphsError)) throw error;
    return {
      ok: false,
      note:
        `Commit ${short(base.repo.sha ?? "")} was analyzed by GitInside ${base.analyzerVersion} ` +
        `and this one by ${head.analyzerVersion}, so they aren't compared: the differences would ` +
        `be the analyzer's, not the code's. This is commit ${short(head.repo.sha ?? "")} alone.`,
    };
  }
}

/**
 * The note for a `base` that can't be compared (fail visibly): what happened, and that the
 * diagram is the page's commit alone. Undefined for a base that loads.
 */
export function baseNote(base: BaseView, sha: string): string | undefined {
  switch (base.status) {
    case "ready":
      return undefined;
    case "missing":
      return `Commit ${short(base.sha)} hasn't been analyzed, so there's nothing to compare with. This is commit ${short(sha)} alone.`;
    case "invalid":
      return `The link's base isn't a full commit SHA, so nothing was compared. This is commit ${short(sha)} alone.`;
  }
}
