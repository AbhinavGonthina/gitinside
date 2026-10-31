import { compareStrings } from "@gitinside/schema";
import type { Confidence, GraphNode, Layer, NodeKind } from "@gitinside/schema";
import type { HierarchyIndex } from "./hierarchy.js";

/**
 * The explorer's filters (M4b.8, UX.md "Filters", ADR-0120): which nodes and
 * connections are left off the canvas. A filter only hides what the graph
 * has; it never adds or guesses anything, and the active ones are always
 * shown as a chip, so nothing disappears silently. Edge kinds are filtered
 * separately, by `ViewOptions.hiddenKinds` (imports are off by default).
 *
 * A node that a rule hides takes everything inside it along, and a folder
 * left with nothing inside goes too. A connection goes when either end is
 * hidden; it isn't redrawn to the hidden node's parent, which would claim
 * the parent itself does it.
 */
export interface Filters {
  /** Layers left off: nodes with that layer and everything inside them. */
  layers: readonly Layer[];
  /** Node kinds left off (from {@link FILTER_KINDS}). */
  kinds: readonly NodeKind[];
  /** Connections of these confidence levels left off. */
  confidence: readonly Confidence[];
  /** Repo folders to show alone; empty shows everything. */
  include: readonly string[];
  /** Repo folders left off. */
  exclude: readonly string[];
  /** Hides test and config files and test folders ({@link isTestOrConfig}). */
  hideTestsAndConfig: boolean;
}

/** Nothing filtered: the canvas shows every node. */
export const NO_FILTERS: Filters = {
  layers: [],
  kinds: [],
  confidence: [],
  include: [],
  exclude: [],
  hideTestsAndConfig: false,
};

/** The explorer's starting filters: tests and config hidden (UX.md "Filters"). */
export const DEFAULT_FILTERS: Filters = { ...NO_FILTERS, hideTestsAndConfig: true };

/**
 * The node kinds the kind filter offers. Services, folders, and files are
 * the structure everything else sits in, so they're filtered by layer and
 * folder instead; the system root is never drawn.
 */
export const FILTER_KINDS: readonly NodeKind[] = [
  "route",
  "page",
  "symbol",
  "model",
  "datastore",
  "queue",
  "external",
  "unresolved",
];

// Folders that hold tests, mocks, and test data by convention.
const TEST_FOLDERS = new Set([
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "test",
  "tests",
  "e2e",
  "cypress",
]);

const TEST_OR_CONFIG_FILE = new RegExp(
  [
    // orders.test.ts, orders.spec.tsx, login.e2e.ts
    String.raw`\.(test|spec|e2e)\.[cm]?[jt]sx?$`,
    // next.config.mjs, vite.config.ts, tailwind.config.js, prisma.config.ts
    String.raw`\.config\.[cm]?[jt]s$`,
    // .eslintrc.js, .prettierrc.cjs
    String.raw`^\.[\w-]+rc\.[cm]?js$`,
    // jest.setup.ts, vitest.setup.ts, setupTests.ts
    String.raw`^(jest|vitest|playwright)\.setup\.[cm]?[jt]sx?$`,
    String.raw`^setupTests\.[cm]?[jt]sx?$`,
  ].join("|"),
);

/**
 * Whether a repo path is a test or config file, or sits in a test folder,
 * by naming convention only (the graph has no such flag). Handles
 * `*.test.*`, `*.spec.*`, `*.e2e.*`, `*.config.*`, `.*rc.js`, test setup
 * files, and folders named `__tests__`, `__mocks__`, `__fixtures__`, `test`,
 * `tests`, `e2e`, or `cypress`. Doesn't treat stories, `fixtures/`, or
 * `.d.ts` files as tests, nor `middleware.ts` and other framework files as
 * config: they're part of what the app is.
 */
export function isTestOrConfig(path: string): boolean {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return (
    parts.some((p) => TEST_FOLDERS.has(p)) ||
    TEST_FOLDERS.has(name) ||
    TEST_OR_CONFIG_FILE.test(name)
  );
}

/** A folder as typed: forward slashes, no `./`, no leading or trailing slash. */
export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

/** Whether `path` is `folder` or inside it, by whole path segments (`api` doesn't hold `apix`). */
export function isUnder(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/** The repo path a node stands for: a service's root, a folder's or file's path, an unresolved call's file. */
function repoPath(node: GraphNode): string | undefined {
  switch (node.kind) {
    case "service":
      return node.root;
    case "module":
    case "file":
      return node.path;
    case "unresolved":
      return node.source?.file;
    default:
      return undefined;
  }
}

/** The filters in one canonical form: lists sorted and deduplicated, folders normalized. */
export function normalizeFilters(filters: Filters): Filters {
  const sorted = <T extends string>(xs: readonly T[]) => [...new Set(xs)].sort(compareStrings);
  const folders = (xs: readonly string[]) =>
    sorted(xs.map(normalizeFolder).filter((f) => f !== ""));
  return {
    layers: sorted(filters.layers),
    kinds: sorted(filters.kinds),
    confidence: sorted(filters.confidence),
    include: folders(filters.include),
    exclude: folders(filters.exclude),
    hideTestsAndConfig: filters.hideTestsAndConfig,
  };
}

/** How many filters are on, for the top bar's count (each toggle and each folder counts once). */
export function activeFilterCount(filters: Filters): number {
  const f = normalizeFilters(filters);
  return (
    f.layers.length +
    f.kinds.length +
    f.confidence.length +
    f.include.length +
    f.exclude.length +
    (f.hideTestsAndConfig ? 1 : 0)
  );
}

/**
 * A key for the filters' effect on the canvas: empty when they hide nothing
 * structural, else their canonical JSON. Equal filters give equal keys
 * whatever order they were set in, so the layout cache can share layouts.
 */
export function filtersKey(filters: Filters): string {
  return activeFilterCount(filters) === 0 ? "" : JSON.stringify(normalizeFilters(filters));
}

/**
 * Every node the filters hide, the root never among them. A node is hidden
 * when its layer or kind is off, when its path is a test or config one (if
 * those are hidden: a test workspace, folder, or file, or an unresolved call
 * in one), when its path is in an excluded folder, or, with
 * folders included, when its path is neither in one of them nor (for a
 * service or folder) above one. Nodes without a path (datastores, queues,
 * outside APIs) aren't affected by folders. Everything inside a hidden node
 * is hidden, and so is a folder whose contents all are.
 */
export function hiddenNodes(index: HierarchyIndex, filters: Filters): ReadonlySet<string> {
  const f = normalizeFilters(filters);
  const hidden = new Set<string>();
  if (activeFilterCount(f) === 0) return hidden;
  const layers = new Set<string>(f.layers);
  const kinds = new Set<string>(f.kinds);

  const ruledOut = (node: GraphNode): boolean => {
    if (node.layer && layers.has(node.layer)) return true;
    if (kinds.has(node.kind)) return true;
    const path = repoPath(node);
    if (path === undefined) return false;
    // A test workspace, a test folder or file, or an unresolved call in one.
    if (f.hideTestsAndConfig && isTestOrConfig(path)) return true;
    if (f.exclude.some((folder) => isUnder(path, folder))) return true;
    if (f.include.length === 0) return false;
    const holds = node.kind === "service" || node.kind === "module";
    return !f.include.some((folder) => isUnder(path, folder) || (holds && isUnder(folder, path)));
  };

  // Returns whether the node stays. Hidden subtrees are still walked, so
  // every node inside them is in the set and an edge check is one lookup.
  const visit = (node: GraphNode, inHidden: boolean): boolean => {
    const off = inHidden || ruledOut(node);
    let kept = 0;
    for (const child of index.children.get(node.id) ?? []) if (visit(child, off)) kept++;
    if (off || (node.kind === "module" && kept === 0)) {
      hidden.add(node.id);
      return false;
    }
    return true;
  };
  for (const top of index.children.get(index.root.id) ?? []) visit(top, false);
  return hidden;
}
