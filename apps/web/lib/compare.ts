import { diffGraphs, IncompatibleGraphsError } from "@gitinside/diff";
import type { ArchitectureGraph, GraphDiff } from "@gitinside/schema";
import type { ExplorerState } from "@gitinside/viewer";
import { short, UNREADABLE_TITLE, type GraphLoad } from "./repoStatus";

/**
 * Diff mode on the website (M6.9e2, ADR-0189): what the diagram page compares its commit
 * with, from the link's `?base=<sha>`. The server says whether that commit has a published
 * analysis (`viewBase`); the browser loads both graphs and diffs them here. No server
 * imports, so the page's client components can use it.
 */

/** What a link's `base` names, as the server found it. */
export type BaseView =
  /**
   * A commit with a published analysis of this repo, and where its graph is. `diffUrl`, when
   * the pull request bot stored a diff of exactly this base and the page's commit (a PR
   * comment's link, M8.6f1): where that diff is (`/api/diff/…`).
   */
  | { status: "ready"; sha: string; graphUrl: string; diffUrl?: string }
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

/**
 * The note for a base whose graph failed to load or parse (M6.11h, fail visibly): this commit
 * stays on screen, alone, rather than giving way to an error card, and the note says why
 * nothing was compared. The card's wording for an unreadable graph ("nothing is shown") would be
 * wrong here, so that case gets its own words. After the note's Try again, `tries` (the loads
 * so far) is named, so each failure reads differently and the live region announces it (M6.11m).
 */
export function baseFailedNote(
  baseSha: string,
  failure: Extract<GraphLoad, { ok: false }>,
  sha: string,
  tries = 1,
): string {
  const alone = `This is commit ${short(sha)} alone.`;
  const again = tries > 1 ? ` after ${tries} tries` : "";
  return failure.title === UNREADABLE_TITLE
    ? `Commit ${short(baseSha)}'s saved diagram ${tries > 1 ? "still " : ""}couldn't be read${again}, so nothing was compared. ${alone}`
    : `Commit ${short(baseSha)}'s diagram ${tries > 1 ? "still " : ""}didn't load${again}, so nothing was compared: ${failure.message} ${alone}`;
}

/** How the note names Base and Head (the explorer's switch says the same). */
const VERSION_WORDS = { base: "Base", head: "Head" } as const;

/**
 * Which nodes each version draws: the overlay's `nodesIn` (`buildDiffOverlay`).
 */
export type VersionNodes = Readonly<Record<keyof typeof VERSION_WORDS, ReadonlySet<string>>>;

/**
 * A link's state as diff mode opens it (M6.11h): a `view` of Base or Head that doesn't have
 * the link's selection or trace start opens on the Overlay, which has both (the explorer's
 * `initialVersion` does the same), so Copy link names the version actually shown, and `note`
 * says what changed and why, naming each node by `nameOf` (as the diagram shows it, not its ID,
 * M6.11m). A version that has them, or the Overlay, is kept as linked.
 */
export function linkedVersion(
  state: ExplorerState,
  nodesIn: VersionNodes,
  nameOf: (id: string) => string,
): { state: ExplorerState; note?: string } {
  if (state.version === "overlay") return { state };
  const has = nodesIn[state.version];
  const lacks = [
    state.selected !== null && !has.has(state.selected)
      ? `the selected ${nameOf(state.selected)}`
      : undefined,
    state.trace !== null && !has.has(state.trace)
      ? `the trace's start, ${nameOf(state.trace)}`
      : undefined,
  ].filter((part) => part !== undefined);
  if (lacks.length === 0) return { state };
  return {
    state: { ...state, version: "overlay" },
    note: `The link opens on ${VERSION_WORDS[state.version]}, which doesn't have ${lacks.join(" or ")}, so both versions are shown (Overlay).`,
  };
}
