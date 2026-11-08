import {
  DEFAULT_STATE,
  BASE_PARAM as VIEWER_BASE_PARAM,
  type ExplorerState,
} from "@gitinside/viewer";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph, type GraphDiff } from "@gitinside/schema";
import { describe, expect, it, vi } from "vitest";
import renameBase from "../../../fixtures/diff-rename-base/expected.json";
import renameHead from "../../../fixtures/diff-rename-head/expected.json";
import {
  BASE_PARAM,
  baseFailedNote,
  baseNote,
  baseParam,
  COMMIT_SHA,
  compareGraphs,
  linkedVersion,
  loadDiff,
} from "./compare";
import { LOAD_FAILED_TITLE, UNREADABLE_MESSAGE, UNREADABLE_TITLE } from "./repoStatus";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

/** A fixture's graph recorded at `sha` (fixtures have none), as the worker stores it. */
const at = (json: unknown, sha: string): ArchitectureGraph => {
  const graph = parseGraph(json);
  return { ...graph, repo: { ...graph.repo, sha } };
};

describe("compareGraphs", () => {
  it("diffs base against head", () => {
    const base = at(renameBase, BASE);
    const head = at(renameHead, HEAD);
    const result = compareGraphs(base, head);
    if (!result.ok) throw new Error(result.note);
    expect(result.base).toBe(base);
    expect(result.diff.base.repo.sha).toBe(BASE);
    expect(result.diff.head.repo.sha).toBe(HEAD);
    const { nodes } = result.diff.summary;
    expect(nodes.added + nodes.removed + nodes.modified + nodes.renamed).toBeGreaterThan(0);
  });

  it("refuses graphs from two analyzer versions, saying why, and draws head alone", () => {
    const base = { ...at(renameBase, BASE), analyzerVersion: "0.0.9" };
    const head = at(renameHead, HEAD);
    expect(compareGraphs(base, head)).toEqual({
      ok: false,
      note: `Commit bbbbbbb was analyzed by GitInside 0.0.9 and this one by ${head.analyzerVersion}, so they aren't compared: the differences would be the analyzer's, not the code's. This is commit aaaaaaa alone.`,
    });
  });
});

describe("compareGraphs with the pull request bot's stored diff (M8.6f2)", () => {
  const base = at(renameBase, BASE);
  const head = at(renameHead, HEAD);
  /** The worker's diff of these graphs: made with file contents, it can carry `renameLimit`. */
  const stored: GraphDiff = { ...diffGraphs(base, head), renameLimit: { removed: 3, added: 1 } };

  it("uses a stored diff of these two commits by their analyzer version", () => {
    const result = compareGraphs(base, head, stored);
    expect(result).toEqual({ ok: true, base, diff: stored });
    if (result.ok) expect(result.diff).toBe(stored);
  });

  it("diffs in the browser when the stored diff names another commit, repo, or version", () => {
    const other = "c".repeat(40);
    const { sha: _, ...unpinned } = stored.base.repo;
    const mismatched: [string, GraphDiff][] = [
      ["base commit", { ...stored, base: { repo: { ...stored.base.repo, sha: other } } }],
      ["head commit", { ...stored, head: { repo: { ...stored.head.repo, sha: other } } }],
      ["no base commit", { ...stored, base: { repo: unpinned } }],
      ["base repo", { ...stored, base: { repo: { ...stored.base.repo, owner: "someone" } } }],
      ["head repo", { ...stored, head: { repo: { ...stored.head.repo, name: "fork" } } }],
      ["analyzer version", { ...stored, analyzerVersion: "0.0.9" }],
    ];
    for (const [what, diff] of mismatched) {
      const result = compareGraphs(base, head, diff);
      if (!result.ok) throw new Error(result.note);
      expect(result.diff, what).not.toHaveProperty("renameLimit");
      expect(result.diff, what).toEqual(diffGraphs(base, head));
    }
  });

  it("diffs in the browser when the stored diff fits the commits but the check refuses it", () => {
    const check = vi.fn((diff: GraphDiff) => {
      if (diff === stored) throw new Error("names a node the graphs don't have");
    });
    const result = compareGraphs(base, head, stored, check);
    expect(check).toHaveBeenCalledWith(stored);
    if (!result.ok) throw new Error(result.note);
    expect(result.diff).toEqual(diffGraphs(base, head));
    // A check that passes keeps it.
    expect(compareGraphs(base, head, stored, () => undefined)).toEqual({
      ok: true,
      base,
      diff: stored,
    });
  });

  it("still refuses graphs from two analyzer versions, whatever was stored", () => {
    const older = { ...base, analyzerVersion: "0.0.9" };
    const result = compareGraphs(older, head, { ...stored, analyzerVersion: "0.0.9" });
    expect(result.ok).toBe(false);
  });
});

describe("loadDiff (M8.6f2)", () => {
  const URL_ = `/api/diff/acme/shop/${BASE}/${HEAD}`;
  const diff = diffGraphs(at(renameBase, BASE), at(renameHead, HEAD));
  const answer = (response: Response | Error) =>
    vi.fn<typeof fetch>(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );

  it("reads and validates the stored diff", async () => {
    const fetch = answer(new Response(JSON.stringify(diff)));
    expect(await loadDiff(URL_, { fetch })).toEqual(diff);
    expect(fetch).toHaveBeenCalledWith(URL_, {});
  });

  it("answers undefined for anything it can't use, so the browser diffs instead", async () => {
    const { summary: _, ...unsummed } = diff;
    for (const response of [
      new Response("{}", { status: 404 }),
      new Response("oops", { status: 503 }),
      new Response("not json"),
      new Response(JSON.stringify(unsummed)),
      new Response(JSON.stringify({ ...diff, summary: { ...diff.summary, broken: 99 } })),
      new TypeError("Failed to fetch"),
    ]) {
      expect(await loadDiff(URL_, { fetch: answer(response) })).toBeUndefined();
    }
  });

  it("passes an abort on, as loadGraph does", async () => {
    const controller = new AbortController();
    controller.abort();
    // jsdom's DOMException isn't an Error, so the fake rejects with a plain one.
    const fetch = answer(new Error("aborted"));
    await expect(loadDiff(URL_, { fetch, signal: controller.signal })).rejects.toThrow("aborted");
  });
});

describe("baseNote", () => {
  it("says nothing for a base that loads", () => {
    expect(baseNote({ status: "ready", sha: BASE, graphUrl: "/g" }, HEAD)).toBeUndefined();
  });

  it("says a base nobody analyzed, or a malformed one, isn't compared", () => {
    expect(baseNote({ status: "missing", sha: BASE }, HEAD)).toBe(
      "Commit bbbbbbb hasn't been analyzed, so there's nothing to compare with. This is commit aaaaaaa alone.",
    );
    expect(baseNote({ status: "invalid" }, HEAD)).toBe(
      "The link's base isn't a full commit SHA, so nothing was compared. This is commit aaaaaaa alone.",
    );
  });
});

describe("baseFailedNote", () => {
  it("says a base that didn't load isn't compared, with the server's reason", () => {
    const failure = {
      ok: false as const,
      title: LOAD_FAILED_TITLE,
      message: "Base unavailable.",
      retry: true,
    };
    expect(baseFailedNote(BASE, failure, HEAD)).toBe(
      "Commit bbbbbbb's diagram didn't load, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.",
    );
  });

  it("says how many tries failed after Try again, so each failure reads differently (M6.11m)", () => {
    const failure = {
      ok: false as const,
      title: LOAD_FAILED_TITLE,
      message: "Base unavailable.",
      retry: true,
    };
    expect(baseFailedNote(BASE, failure, HEAD, 2)).toBe(
      "Commit bbbbbbb's diagram still didn't load after 2 tries, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.",
    );
    expect(baseFailedNote(BASE, failure, HEAD, 3)).toBe(
      "Commit bbbbbbb's diagram still didn't load after 3 tries, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.",
    );
    const unreadable = { ...failure, title: UNREADABLE_TITLE, message: UNREADABLE_MESSAGE };
    expect(baseFailedNote(BASE, unreadable, HEAD, 2)).toBe(
      "Commit bbbbbbb's saved diagram still couldn't be read after 2 tries, so nothing was compared. This is commit aaaaaaa alone.",
    );
  });

  it("says a base that couldn't be read isn't compared, without the card's wording", () => {
    const failure = {
      ok: false as const,
      title: UNREADABLE_TITLE,
      message: UNREADABLE_MESSAGE,
      retry: false,
    };
    expect(baseFailedNote(BASE, failure, HEAD)).toBe(
      "Commit bbbbbbb's saved diagram couldn't be read, so nothing was compared. This is commit aaaaaaa alone.",
    );
  });
});

describe("linkedVersion (M6.11h)", () => {
  const nodesIn = {
    base: new Set(["service:api/", "route:api/GET /old"]),
    head: new Set(["service:api/", "route:api/GET /new"]),
  };
  const state = (over: Partial<ExplorerState>): ExplorerState => ({
    ...DEFAULT_STATE,
    ...over,
  });
  // How the page names a node (M6.11m): its kind and label, as the diagram shows it.
  const names: Record<string, string> = {
    "route:api/GET /old": "route GET /old",
    "route:api/GET /new": "route GET /new",
  };
  const nameOf = (id: string) => names[id] ?? id;

  it("keeps a version that has the link's selection and trace start", () => {
    const linked = state({ version: "head", selected: "route:api/GET /new" });
    expect(linkedVersion(linked, nodesIn, nameOf)).toEqual({ state: linked });
    const overlay = state({ selected: "route:api/GET /old" });
    expect(linkedVersion(overlay, nodesIn, nameOf)).toEqual({ state: overlay });
  });

  it("opens on the Overlay when the version lacks them, and says so by name, not ID", () => {
    const linked = state({ version: "head", selected: "route:api/GET /old" });
    expect(linkedVersion(linked, nodesIn, nameOf)).toEqual({
      state: { ...linked, version: "overlay" },
      note: "The link opens on Head, which doesn't have the selected route GET /old, so both versions are shown (Overlay).",
    });
    const traced = state({ version: "base", trace: "route:api/GET /new", step: 0 });
    expect(linkedVersion(traced, nodesIn, nameOf)).toEqual({
      state: { ...traced, version: "overlay" },
      note: "The link opens on Base, which doesn't have the trace's start, route GET /new, so both versions are shown (Overlay).",
    });
    const both = state({
      version: "base",
      selected: "route:api/GET /new",
      trace: "route:api/GET /new",
    });
    expect(linkedVersion(both, nodesIn, nameOf).note).toBe(
      "The link opens on Base, which doesn't have the selected route GET /new or the trace's start, route GET /new, so both versions are shown (Overlay).",
    );
  });
});

describe("the base parameter", () => {
  it("is named as the explorer's codec names it", () => {
    expect(BASE_PARAM).toBe(VIEWER_BASE_PARAM);
  });

  it("takes the last of a repeated one, like the codec", () => {
    expect(baseParam(undefined)).toBeUndefined();
    expect(baseParam(BASE)).toBe(BASE);
    expect(baseParam(["x", BASE])).toBe(BASE);
  });

  it("is a full, lowercase SHA", () => {
    expect(COMMIT_SHA.test(BASE)).toBe(true);
    expect(COMMIT_SHA.test("bbbbbbb")).toBe(false);
    expect(COMMIT_SHA.test("B".repeat(40))).toBe(false);
    expect(COMMIT_SHA.test(`${BASE}0`)).toBe(false);
  });
});
