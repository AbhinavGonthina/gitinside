import { compareStrings, type ArchitectureGraph, type GraphNode } from "@gitinside/schema";

type FileNode = Extract<GraphNode, { kind: "file" }>;
type ModuleNode = Extract<GraphNode, { kind: "module" }>;
type SymbolNode = Extract<GraphNode, { kind: "symbol" }>;
type UnresolvedNode = Extract<GraphNode, { kind: "unresolved" }>;

/**
 * File contents of the two analyzed commits, by repo-relative path (a file node's `path`,
 * a symbol's `source.file`). Return `undefined` for a file you can't read. The caller
 * must give the contents of exactly the commits the graphs were built from: the diff
 * runs in browsers too, so it can't hash the text to check it against the file's `hash`.
 */
export interface FileContents {
  base(path: string): string | undefined;
  head(path: string): string | undefined;
}

/**
 * Thresholds (ADR-0086), measured on 5,898 files of cal.com and the eval repos at their
 * pinned commits (`packages/diff` M6.3 notes): with 4-token shingles, a file with 20% of
 * its lines deleted or 20% new lines inserted scores ≥ 0.6 in 96% and 92% of 400 samples,
 * and two random files of different content score ≥ 0.6 in 0.04% of 20,000 pairs.
 */
export const RENAME_THRESHOLDS = {
  /** Tokens per shingle. 3 matched slightly more edits; 5 lost a tenth of them. */
  shingleSize: 4,
  /** Least shingle Jaccard for a moved file whose content changed (DESIGN.md §8). */
  fileSimilarity: 0.6,
  /** Files with fewer tokens are matched only by identical content: their scores swing. */
  minFileTokens: 50,
  /** Least body Jaccard for a same-name symbol in a moved file or class (DESIGN.md §8). */
  symbolSimilarity: 0.8,
  /** Bodies with fewer tokens never match by equality alone (`const a = 1;` is 5). */
  minBodyTokens: 20,
  /**
   * Past this many removed × added file pairs, content is compared only between files
   * with the same base name, so a large refactor stays near-linear. Identical content
   * is always matched.
   */
  maxFilePairs: 250_000,
} as const;

const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*|\p{N}[\p{L}\p{N}_.]*|\S/gu;

/** Identifiers, numbers, and single punctuation characters; whitespace never counts. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** The set of `size`-token windows; a sequence shorter than `size` is one shingle. */
function shingles(tokens: readonly string[], size: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < size) out.add(tokens.join("\u0000"));
  for (let i = 0; i + size <= tokens.length; i++) {
    out.add(tokens.slice(i, i + size).join("\u0000"));
  }
  return out;
}

/** |A ∩ B| / |A ∪ B|, and 1 for two empty sets. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Shingled-token Jaccard similarity of two texts (DESIGN.md §8), between 0 and 1. */
export function similarity(a: string, b: string): number {
  const size = RENAME_THRESHOLDS.shingleSize;
  return jaccard(shingles(tokenize(a), size), shingles(tokenize(b), size));
}

interface Candidate {
  from: string;
  to: string;
  score: number;
  /** Breaks score ties first: e.g. the same base name for files. */
  rank: number;
}

/**
 * Pair candidates best score first. Candidates with equal score and rank form a tier;
 * within a tier, a pair is taken only if neither end has another candidate there, and
 * every end that was ambiguous is left out of lower tiers too, so a tie is never broken
 * by guessing (two identical files removed and two added stay removed + added).
 */
function assign(candidates: Candidate[], into: Map<string, string>): void {
  const claimed = new Set<string>();
  const sorted = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      b.rank - a.rank ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to),
  );
  const tiers: Candidate[][] = [];
  for (const c of sorted) {
    const first = tiers.at(-1)?.[0];
    if (first?.score === c.score && first.rank === c.rank) tiers.at(-1)?.push(c);
    else tiers.push([c]);
  }
  for (const all of tiers) {
    const tier = all.filter((c) => !claimed.has(`b:${c.from}`) && !claimed.has(`h:${c.to}`));
    const count = new Map<string, number>();
    for (const c of tier) {
      count.set(`b:${c.from}`, (count.get(`b:${c.from}`) ?? 0) + 1);
      count.set(`h:${c.to}`, (count.get(`h:${c.to}`) ?? 0) + 1);
    }
    for (const c of tier) {
      if (count.get(`b:${c.from}`) === 1 && count.get(`h:${c.to}`) === 1) into.set(c.from, c.to);
    }
    for (const key of count.keys()) claimed.add(key);
  }
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Shingles of a file's text, or `undefined` when unread or too short to score. */
function fileShingles(text: string | undefined): Set<string> | undefined {
  if (text === undefined) return undefined;
  const tokens = tokenize(text);
  if (tokens.length < RENAME_THRESHOLDS.minFileTokens) return undefined;
  return shingles(tokens, RENAME_THRESHOLDS.shingleSize);
}

/**
 * Moved files: identical content (`hash`) scores 1; otherwise, with contents, a
 * shingle similarity ≥ `fileSimilarity`. A shared base name breaks ties.
 */
function matchFiles(
  removed: readonly FileNode[],
  added: readonly FileNode[],
  contents: FileContents | undefined,
  into: Map<string, string>,
): void {
  const candidates: Candidate[] = [];
  const rank = (b: FileNode, h: FileNode) => (baseName(b.path) === baseName(h.path) ? 1 : 0);

  const byHash = new Map<string, FileNode[]>();
  for (const h of added) byHash.set(h.hash, [...(byHash.get(h.hash) ?? []), h]);
  for (const b of removed) {
    for (const h of byHash.get(b.hash) ?? []) {
      candidates.push({ from: b.id, to: h.id, score: 1, rank: rank(b, h) });
    }
  }

  if (contents !== undefined) {
    const before = new Map(removed.map((b) => [b.id, fileShingles(contents.base(b.path))]));
    const after = new Map(added.map((h) => [h.id, fileShingles(contents.head(h.path))]));
    const everyPair = removed.length * added.length <= RENAME_THRESHOLDS.maxFilePairs;
    const byName = new Map<string, FileNode[]>();
    for (const h of added)
      byName.set(baseName(h.path), [...(byName.get(baseName(h.path)) ?? []), h]);
    for (const b of removed) {
      const a = before.get(b.id);
      if (a === undefined) continue;
      for (const h of everyPair ? added : (byName.get(baseName(b.path)) ?? [])) {
        const c = after.get(h.id);
        if (c === undefined || h.hash === b.hash) continue;
        const score = jaccard(a, c);
        if (score >= RENAME_THRESHOLDS.fileSimilarity) {
          candidates.push({ from: b.id, to: h.id, score, rank: rank(b, h) });
        }
      }
    }
  }
  assign(candidates, into);
}

/**
 * Moved folders: a removed module whose files moved, more than half of them into one
 * added module that got more than half of its files from it. Only direct file children
 * vote; a module always has at least one (modules are folders holding source files).
 */
function matchModules(
  removed: readonly ModuleNode[],
  added: readonly ModuleNode[],
  base: ReadonlyMap<string, GraphNode>,
  head: ReadonlyMap<string, GraphNode>,
  into: Map<string, string>,
): void {
  const addedIds = new Set(added.map((m) => m.id));
  const filesOf = (nodes: ReadonlyMap<string, GraphNode>) => {
    const count = new Map<string, number>();
    for (const node of nodes.values()) {
      if (node.kind === "file" && node.parentId !== null) {
        count.set(node.parentId, (count.get(node.parentId) ?? 0) + 1);
      }
    }
    return count;
  };
  const baseFiles = filesOf(base);
  const headFiles = filesOf(head);

  const votes = new Map<string, Map<string, number>>();
  for (const [from, to] of into) {
    const b = base.get(from);
    const h = head.get(to);
    if (b?.kind !== "file" || h?.kind !== "file" || b.parentId === null || h.parentId === null) {
      continue;
    }
    if (!addedIds.has(h.parentId)) continue;
    const forModule = votes.get(b.parentId) ?? new Map<string, number>();
    forModule.set(h.parentId, (forModule.get(h.parentId) ?? 0) + 1);
    votes.set(b.parentId, forModule);
  }

  const candidates: Candidate[] = [];
  for (const m of removed) {
    for (const [to, n] of votes.get(m.id) ?? []) {
      if (2 * n > (baseFiles.get(m.id) ?? 0) && 2 * n > (headFiles.get(to) ?? 0)) {
        candidates.push({ from: m.id, to, score: n, rank: 0 });
      }
    }
  }
  assign(candidates, into);
}

/** The text a symbol's `source` spans, from its first line to `endLine`. */
function bodyText(symbol: SymbolNode, read: ((path: string) => string | undefined) | undefined) {
  const { source } = symbol;
  if (read === undefined || source?.endLine === undefined) return undefined;
  const text = read(source.file);
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .slice(source.line - 1, source.endLine)
    .join("\n");
}

/** A symbol body's tokens with its own name masked, so renaming `foo` to `bar` keeps them equal. */
function bodyTokens(symbol: SymbolNode, read: ((path: string) => string | undefined) | undefined) {
  const text = bodyText(symbol, read);
  return text === undefined
    ? undefined
    : tokenize(text).map((token) => (token === symbol.label ? "\u0001" : token));
}

/** How symbol IDs under a node start: `symbol:<file's ID path>#` or `<class ID>.`. */
function childPrefix(parent: GraphNode): string | undefined {
  if (parent.kind === "file") return `symbol:${parent.id.slice("file:".length)}#`;
  if (parent.kind === "symbol") return `${parent.id}.`;
  return undefined;
}

/**
 * Moved and renamed symbols, after files:
 * 1. A symbol whose parent (file or class) was renamed, and the same name under the new
 *    parent with the same `symbolKind`, matches when its body similarity is at least
 *    `symbolSimilarity`, or when either body can't be read.
 * 2. Otherwise a body equal token for token (its own name masked, at least
 *    `minBodyTokens`), same `symbolKind`, and the only such body among both sides'
 *    leftovers: a function renamed in place or moved to another file.
 * Rule 1 runs again after rule 2, so the methods of a class renamed by rule 2 follow it.
 */
function matchSymbols(
  removed: readonly SymbolNode[],
  added: readonly SymbolNode[],
  base: ReadonlyMap<string, GraphNode>,
  head: ReadonlyMap<string, GraphNode>,
  contents: FileContents | undefined,
  into: Map<string, string>,
): void {
  const addedById = new Map(added.map((s) => [s.id, s]));
  const taken = new Set(into.values());
  // Nesting below the file: dots after `#` (`F#Class.method` is 1), so classes go first.
  const depth = (s: SymbolNode) => s.id.slice(s.id.indexOf("#")).split(".").length;
  const ordered = [...removed].sort((a, b) => depth(a) - depth(b) || compareStrings(a.id, b.id));
  const readBase = contents && ((path: string) => contents.base(path));
  const readHead = contents && ((path: string) => contents.head(path));

  const followParents = (): void => {
    for (const b of ordered) {
      if (into.has(b.id) || b.parentId === null) continue;
      const parentTo = into.get(b.parentId);
      const oldParent = base.get(b.parentId);
      const newParent = parentTo === undefined ? undefined : head.get(parentTo);
      if (oldParent === undefined || newParent === undefined) continue;
      const oldPrefix = childPrefix(oldParent);
      const newPrefix = childPrefix(newParent);
      if (oldPrefix === undefined || newPrefix === undefined || !b.id.startsWith(oldPrefix)) {
        continue;
      }
      const h = addedById.get(newPrefix + b.id.slice(oldPrefix.length));
      if (h === undefined || taken.has(h.id) || h.symbolKind !== b.symbolKind) continue;
      if (h.parentId !== newParent.id) continue;
      const before = bodyTokens(b, readBase);
      const after = bodyTokens(h, readHead);
      if (before !== undefined && after !== undefined) {
        const size = RENAME_THRESHOLDS.shingleSize;
        if (
          jaccard(shingles(before, size), shingles(after, size)) <
          RENAME_THRESHOLDS.symbolSimilarity
        ) {
          continue;
        }
      }
      into.set(b.id, h.id);
      taken.add(h.id);
    }
  };

  followParents();
  if (contents !== undefined) {
    const key = (s: SymbolNode, read: (path: string) => string | undefined) => {
      const tokens = bodyTokens(s, read);
      if (tokens === undefined || tokens.length < RENAME_THRESHOLDS.minBodyTokens) return undefined;
      return `${s.symbolKind}\u0002${tokens.join("\u0000")}`;
    };
    const group = (symbols: readonly SymbolNode[], read: (path: string) => string | undefined) => {
      const groups = new Map<string, SymbolNode[]>();
      for (const s of symbols) {
        const k = key(s, read);
        if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), s]);
      }
      return groups;
    };
    const before = group(
      removed.filter((s) => !into.has(s.id)),
      (path) => contents.base(path),
    );
    const after = group(
      added.filter((s) => !taken.has(s.id)),
      (path) => contents.head(path),
    );
    for (const [k, bs] of before) {
      const hs = after.get(k) ?? [];
      const [b] = bs;
      const [h] = hs;
      if (bs.length === 1 && hs.length === 1 && b !== undefined && h !== undefined) {
        into.set(b.id, h.id);
        taken.add(h.id);
      }
    }
    followParents();
  }
}

/**
 * Unresolved nodes, whose IDs are their position (`unresolved:<service>/<file>:<line>:<col>`):
 * same reason, expression, and detail in the same file (or the file it was moved to).
 * They pair in source order, and only when both sides have as many of them, so a line
 * shift or a moved file keeps them, and one of two equal calls removed never guesses which.
 */
function matchUnresolved(
  removed: readonly UnresolvedNode[],
  added: readonly UnresolvedNode[],
  movedPaths: ReadonlyMap<string, string>,
  into: Map<string, string>,
): void {
  const group = (nodes: readonly UnresolvedNode[], map: (file: string) => string) => {
    const groups = new Map<string, UnresolvedNode[]>();
    for (const node of nodes) {
      if (node.source === undefined) continue;
      const k = JSON.stringify([
        map(node.source.file),
        node.reason,
        node.expression,
        node.detail ?? "",
      ]);
      groups.set(k, [...(groups.get(k) ?? []), node]);
    }
    return groups;
  };
  // Grouped nodes all have a source; the fallback only satisfies the type.
  const at = (n: UnresolvedNode) => n.source ?? { line: 0, column: 0 };
  const byPosition = (a: UnresolvedNode, b: UnresolvedNode) =>
    at(a).line - at(b).line || at(a).column - at(b).column || compareStrings(a.id, b.id);
  const before = group(removed, (file) => movedPaths.get(file) ?? file);
  const after = group(added, (file) => file);
  for (const [k, bs] of before) {
    const hs = after.get(k);
    if (hs === undefined || hs.length !== bs.length) continue;
    const sortedHeads = [...hs].sort(byPosition);
    [...bs].sort(byPosition).forEach((b, i) => {
      const h = sortedHeads[i];
      if (h !== undefined) into.set(b.id, h.id);
    });
  }
}

/**
 * Find which base-only nodes reappear in head under another ID (DESIGN.md §8 step 2):
 * moved or renamed files, the folders they moved with, the symbols inside them (or
 * renamed in place), and the unresolved calls inside them. Returns base ID ⇒ head ID,
 * one-to-one, only between `removed` base IDs and `added` head IDs of the same kind.
 *
 * Without `contents`, files match only by identical content and symbols only by
 * following their file or class. Deterministic: candidates are scored and sorted, and
 * ties are left unmatched rather than broken.
 *
 * Doesn't handle: renamed services (every ID in them changes), models, routes, pages,
 * or queues (their IDs carry no file, so a moved declaration keeps its ID and shows as
 * `updated`), or a file split in two (at most one half is matched).
 */
export function detectRenames(
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  removed: ReadonlySet<string>,
  added: ReadonlySet<string>,
  contents?: FileContents,
): Map<string, string> {
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const only = <K extends GraphNode["kind"]>(
    nodes: readonly GraphNode[],
    ids: ReadonlySet<string>,
    kind: K,
  ) => nodes.filter((n): n is Extract<GraphNode, { kind: K }> => n.kind === kind && ids.has(n.id));

  const renames = new Map<string, string>();
  matchFiles(only(base.nodes, removed, "file"), only(head.nodes, added, "file"), contents, renames);
  const movedPaths = new Map<string, string>();
  for (const [from, to] of renames) {
    const b = baseNodes.get(from) as FileNode;
    const h = headNodes.get(to) as FileNode;
    movedPaths.set(b.path, h.path);
  }
  matchModules(
    only(base.nodes, removed, "module"),
    only(head.nodes, added, "module"),
    baseNodes,
    headNodes,
    renames,
  );
  matchSymbols(
    only(base.nodes, removed, "symbol"),
    only(head.nodes, added, "symbol"),
    baseNodes,
    headNodes,
    contents,
    renames,
  );
  matchUnresolved(
    only(base.nodes, removed, "unresolved"),
    only(head.nodes, added, "unresolved"),
    movedPaths,
    renames,
  );
  return renames;
}
