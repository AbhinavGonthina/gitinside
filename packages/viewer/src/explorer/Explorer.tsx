import { compareStrings } from "@gitinside/schema";
import type { ArchitectureGraph, EdgeKind, GraphDiff, GraphNode } from "@gitinside/schema";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button, SegmentedControl, StatusChip } from "../chrome/controls.js";
import { shortSha, type Rect, type RepoRef } from "../chrome/describe.js";
import { EmptyState, WarningList } from "../chrome/EmptyState.js";
import { FiltersPopover } from "../chrome/FiltersPopover.js";
import { ShareMenu } from "../chrome/ShareMenu.js";
import { viewExport, type ViewExport } from "../export/files.js";
import { Breadcrumbs, CanvasToolbar, Legend, Minimap, ZoomControls } from "../chrome/overlays.js";
import { DIFF_VIEWS, TopBar, type CommitStatus, type DiffView } from "../chrome/TopBar.js";
import { buildDiffOverlay, DiffMismatchError, diffMarks, versionGraph } from "../model/diff.js";
import {
  createLayoutCache,
  createLayoutEngine,
  type LayoutEngine,
  type LayoutWorkerFactory,
} from "../layout/engine.js";
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filterOptions,
  filtersShowing,
  hiddenNodes,
  NO_FILTERS,
  readerFilterCount,
  type Filters,
} from "../model/filters.js";
import { summarizeGraph } from "../model/groups.js";
import {
  buildHierarchy,
  isWithin,
  layerOf,
  nodeOf,
  type HierarchyIndex,
} from "../model/hierarchy.js";
import {
  buildView,
  DEFAULT_HIDDEN_KINDS,
  viewTrail,
  visibleAncestor,
  type GraphView,
  type ViewEdge,
  type ViewNode,
} from "../model/view.js";
import { hasSourceFiles, warningCount } from "../model/warnings.js";
import { usePresence } from "../motion.js";
import { nodeLabel } from "../nodes/describe.js";
import { durations } from "../tokens.js";
import { selectionAnnouncement } from "./a11y.js";
import {
  centerOn,
  clampZoom,
  ensureVisible,
  frameHop,
  holdInPlace,
  keepInView,
  sameCamera,
  stepZoom,
  visibleRect,
  zoomToBox,
  type Camera,
  type Size,
} from "./camera.js";
import { ChangesSection, movesNote } from "./changes.js";
import { encodeState, withState, type ExplorerState } from "./deepLink.js";
import { DrillCanvas, toggledBetween, type BoxLook, type LineLook } from "./DrillCanvas.js";
import { useDrill, type Expansion } from "./drill.js";
import {
  autoCamera,
  belowBand,
  boxesRect,
  clearOfOverlays,
  fitLevel,
  hubOf,
  lastOpened,
} from "./framing.js";
import { useCanvasGestures, type CameraMotion } from "./gestures.js";
import { useGlideSpan } from "./glide.js";
import {
  HintLine,
  hintLine,
  hintSteps,
  OnboardingHint,
  type HintStep,
  type OnboardingStore,
} from "./onboarding.js";
import { NodePanel, TracePanel, WARNINGS_SECTION } from "./panels.js";
import { traceChoices, TracePicker } from "./picker.js";
import { suggestTraces } from "./suggest.js";
import { NOTES_ENTRY, notesEntries, SearchPalette, searchEntries } from "./search.js";
import { useSourceAccess, type SourceLoader } from "./sources.js";
import { openForPath } from "./pathView.js";
import { canTraceFrom, hasHops, traceFrom, traceNodes, type TraceStep } from "./trace.js";
import type { Shown } from "./transition.js";

/** How long the player stays on a step: the pulse travels its hop three times. */
export const PLAY_STEP_MS = durations["trace-hop"] * 3;

/** Room between the first-visit hint's card and the diagram fitted below it: the overlays' 16px spacing. */
const HINT_GAP = 16;

/** Props for {@link Explorer}. */
export interface ExplorerProps {
  graph: ArchitectureGraph;
  /** File text by repo-relative path, for code previews. Missing files show no preview. */
  sources?: Readonly<Record<string, string>> | undefined;
  /**
   * Loads a file's text when the inspector needs it (e.g. `createGitHubSourceLoader`),
   * for files not in `sources`. Each path is loaded once; a failed load says so in the
   * code preview. Without either, nodes show no code, only their GitHub link.
   */
  loadSource?: SourceLoader | undefined;
  /**
   * The page or route that T and the Trace button trace when the selection
   * isn't a page or route (e.g. a demo's lead request). Without one, they
   * trace the selected page or route, or open a picker of every page and
   * route that has a request path.
   */
  traceStart?: string | undefined;
  /** Start with these nodes broken down, in opening order (the last one is closed first by Esc). */
  initialOpen?: Expansion;
  /** Start with this node selected. */
  initialSelected?: string | null;
  /**
   * Start tracing from this page or route (e.g. a deep link's `trace`), at
   * `initialStep` or its first step. Ignored if it isn't in the graph or has
   * no request path.
   */
  initialTrace?: string | null | undefined;
  /** Start tracing at this step (0-based): from `initialTrace`, else from `traceStart`. */
  initialStep?: number | null;
  /**
   * Start at this zoom (clamped to 25–200%), centered on the first level, as
   * if zoomed there by hand, instead of fitted. 0 or the fit button fits as
   * usual.
   */
  initialZoom?: number | undefined;
  /** Start with these filters instead of `DEFAULT_FILTERS` (tests and config hidden). */
  initialFilters?: Filters | undefined;
  /** Start with these connection kinds hidden instead of `DEFAULT_HIDDEN_KINDS` (imports). */
  initialHiddenKinds?: readonly EdgeKind[] | undefined;
  /**
   * Called after the reader breaks down, closes, selects, traces, steps, or
   * filters, with the state a deep link restores (`encodeState`); not for
   * the state the explorer opened with, nor for changes a deep link doesn't
   * keep (camera, play/pause). The initial props take a decoded state back
   * (`decodeState`).
   */
  onStateChange?: ((state: ExplorerState) => void) | undefined;
  /**
   * The link the top bar's share menu copies, from the current state's query
   * (`encodeState`, empty at the default state). Default: this page's URL
   * with that query.
   */
  linkTo?: ((query: string) => string) | undefined;
  /**
   * Kept pointing at the view on screen as an export (`viewExport`: the
   * drawn view at its layout), `undefined` until the first layout, for a
   * host's own share menu (`ShareMenu`'s `exports`). The top bar's share
   * menu exports it without this.
   */
  exportRef?: { current: ViewExport | undefined } | undefined;
  /**
   * Draw the explorer's own top bar (default). The website turns it off and shows its own
   * repo bar (with its own share menu); Ctrl+K still searches, and a Filters button or the
   * filters chip on the canvas opens the filters.
   */
  topBar?: boolean;
  /**
   * Shows the first-visit hints (zoom in → select → trace) unless `done()`,
   * and `remember()`s when they're finished or turned off
   * (`browserOnboarding()`: per browser). Without one, no hints.
   */
  onboarding?: OnboardingStore | undefined;
  /** Makes the layout worker (see `LayoutWorkerFactory`). Without one, layouts run on the main thread. */
  layoutWorker?: LayoutWorkerFactory | undefined;
  /** How many boxes and lines a level needs before the canvas culls it (default `CULL_FROM`). */
  cullFrom?: number | undefined;
  /**
   * Diff mode (UX.md "Diff mode"): compare `graph`, the head, with a base
   * commit's graph through `packages/diff`'s diff of the two. The canvas then
   * draws both versions on one layout (`buildDiffOverlay`) as the Overlay
   * (added, changed, removed ghosted, broken connections), or Base or Head
   * alone from the top bar (on the canvas, next to the "Comparing" chip,
   * when `topBar` is off). A diff of other graphs shows an error card.
   */
  diff?: ExplorerDiff | undefined;
  /**
   * Start diff mode on Base or Head (a deep link's `view`) instead of the
   * Overlay. Ignored outside diff mode, and the Overlay is shown instead when
   * that version doesn't have `initialSelected` or `initialTrace`.
   */
  initialVersion?: DiffView | undefined;
  /**
   * Which design to draw (M10.3): `"current"` (default) is the shipped explorer; `"prototype"` is
   * the M10 redesign under review at the design gate, only for the website's unlinked
   * `/prototype` page until Abhinav approves it. So far: the top level in bands, its shared
   * packages and outside hosts grouped, its "uses code" lines quiet behind the boxes, a first
   * view fitted at 70% or more, else on the hub at 80%, and cards whose names wrap rather than
   * end in "…", with a count row and role on every service and logos on a host group's tile;
   * and one bar for the whole page, with the drill-down path in it (`home`, `commitStatus`,
   * `topBarEnd`); on the canvas, at most three overlays (M10.3c2): status chips only for what's
   * on (no filter chip for the default hiding, no warnings chip), one bottom-right toolbar
   * (zoom, fit, the minimap's toggle, the legend), and a one-line first-visit hint instead of
   * the tip cards, with hairlines instead of the soft shadow; unlinked datastores captioned; and
   * the panel (M10.3c3): the overview's one sentence, counts, "Try this", services, and Analysis
   * notes collapsed at the foot (also from Ctrl K), a node's brief of at most 30 words with a
   * fact grid, and Calls / Called by grouped by target.
   */
  design?: ExplorerDesign | undefined;
  /**
   * For `design="prototype"`'s one page bar (M10-design A7): where the mark links, the commit
   * chip's status, and the page's own items at the bar's end (theme, sign-in). The drill-down
   * path moves into the bar too. Ignored by the shipped design.
   */
  home?: string | undefined;
  commitStatus?: CommitStatus | undefined;
  topBarEnd?: ReactNode;
}

/** The explorer's designs: the shipped one, and the M10 redesign under review (M10.3). */
export type ExplorerDesign = "current" | "prototype";

/** What diff mode compares `graph` (the head) with. */
export interface ExplorerDiff {
  base: ArchitectureGraph;
  diff: GraphDiff;
  /** The base and head as the chip names them ("main", "PR #12"); default their short SHAs. */
  baseName?: string | undefined;
  headName?: string | undefined;
  /**
   * Base's file text and loader, as `sources` and `loadSource` are head's
   * (e.g. `createGitHubSourceLoader` at the base commit). The inspector reads
   * what only base has from these (every node in Base; a removed node or hop
   * in the Overlay) and links it at base's commit. Without either, those show
   * no code, only their GitHub link, rather than head's file.
   */
  sources?: Readonly<Record<string, string>> | undefined;
  loadSource?: SourceLoader | undefined;
}

/** Each diff view in words, for announcements. */
const VERSION_TEXT: Readonly<Record<DiffView, string>> = {
  base: "the base version",
  head: "the head version",
  overlay: "the changes between base and head",
};

/** What the share menu says each diff view exports (M6.11e): files never mark changes. */
export const EXPORT_NOTES: Readonly<Record<DiffView, string>> = {
  base: "Files show the base version, as on screen.",
  head: "Files show the head version, as on screen.",
  overlay: "Files show the head version, without marking the changes.",
};

/** This page's URL with a state's query (the default `linkTo`). */
function pageLink(query: string): string {
  if (typeof window === "undefined") return withState("", query);
  return withState(`${window.location.origin}${window.location.pathname}`, query);
}

/** The node opened last that's still open on the canvas: the end of the breadcrumb trail. */
function deepestOpen(view: GraphView, expansion: Expansion): string | undefined {
  const open = new Set(view.open);
  for (let i = expansion.length - 1; i >= 0; i--) {
    const id = expansion[i];
    if (id !== undefined && open.has(id)) return id;
  }
  return undefined;
}

/**
 * The interactive explorer (M4b.3b): the top bar, the drill-down canvas, its
 * overlays, and the inspector, on any analyzer graph. Boxes break down in
 * place to any depth (double-click, Enter, or **Break down**; Esc or a
 * breadcrumb goes back up), with a service's routes and pages first. A click
 * or Space selects; the canvas marks the box that holds the selection, and a
 * connection in the inspector drills to its node. **Trace from here** on a
 * page or route, T, or the Trace button follows its request path
 * (`traceFrom`) step by step, on whatever boxes hold its hops at the current
 * depth; with nothing to start from, they open a searchable picker of pages
 * and routes. The player steps by hand or plays (a step every
 * {@link PLAY_STEP_MS}), and a pulse travels the current hop. Ctrl+K, ⌘K,
 * or the top bar's search field opens the command palette over every node
 * (`searchNodes`); a pick drills to it, selects it, and focuses its box.
 *
 * Layouts come from ELK, in the host's Web Worker when given one. Each level
 * is fitted to the canvas, or, when it's too big to read whole, framed on the
 * node broken down last, from its name and entries, at a readable size
 * (`autoCamera`), until the user pans (drag, wheel, or the minimap) or zooms
 * (Ctrl or ⌘ + wheel, a pinch, − / +, or the zoom buttons); from then on the
 * camera is theirs, and breaking a node down keeps that node where it was on
 * the canvas, until they fit again (0 or the fit button: the whole level).
 * Each trace step frames its hop's two ends clear of the minimap
 * (`frameHop`), and again when Play starts or a drill-down lands.
 * Text thins out as the camera zooms out (`detailAt`): subtitles, counts,
 * and edge labels first, then everything but service names and the lines
 * between services.
 */
export function Explorer({
  graph: given,
  sources,
  loadSource,
  traceStart,
  initialOpen = [],
  initialSelected = null,
  initialTrace = null,
  initialStep = null,
  initialZoom,
  initialFilters = DEFAULT_FILTERS,
  initialHiddenKinds,
  onStateChange,
  linkTo = pageLink,
  exportRef,
  topBar = true,
  onboarding,
  layoutWorker,
  cullFrom,
  diff: compare,
  initialVersion = "overlay",
  design = "current",
  home,
  commitStatus,
  topBarEnd,
}: ExplorerProps) {
  // Diff mode (M6.9b): both versions in one graph, drawn with their states.
  const compareBase = compare?.base;
  const compareDiff = compare?.diff;
  const compared = useMemo(() => {
    if (!compareBase || !compareDiff) return undefined;
    try {
      return { overlay: buildDiffOverlay(compareBase, given, compareDiff) };
    } catch (e) {
      if (e instanceof DiffMismatchError) return { mismatch: e.message };
      throw e;
    }
  }, [compareBase, compareDiff, given]);
  const overlay = compared?.overlay;
  const marks = useMemo(() => overlay && diffMarks(overlay), [overlay]);
  const [version, setVersion] = useState<DiffView>(() => {
    if (!overlay || initialVersion === "overlay") return "overlay";
    const has = overlay.nodesIn[initialVersion];
    const lacks = [initialSelected, initialTrace].some(
      (id) => typeof id === "string" && !has.has(id),
    );
    return lacks ? "overlay" : initialVersion;
  });
  // The prototype's system level summarizes (M10.3b1): shared packages and outside hosts grouped.
  const summarized = useMemo(
    () => (design === "prototype" ? summarizeGraph(given) : given),
    [design, given],
  );
  const graph = overlay?.graph ?? summarized;
  const index = useMemo(() => buildHierarchy(graph), [graph]);
  /**
   * What Base or Head holds, on the overlay's IDs (M6.9c): traces, the trace
   * picker, and the palette follow only that version. The overlay's otherwise.
   */
  const shownIndex = useMemo(
    () =>
      overlay && version !== "overlay" ? buildHierarchy(versionGraph(overlay, version)) : index,
    [overlay, version, index],
  );
  const hasApp = useMemo(() => hasSourceFiles(graph), [graph]);
  const sourceAccess = useSourceAccess(sources, loadSource);
  const baseSourceAccess = useSourceAccess(compare?.sources, compare?.loadSource);
  // Made in an effect, not during render, so it's disposed by the same
  // mount it was made in: React StrictMode's simulated unmount and remount
  // (development) then gets a fresh engine and worker, rather than one already
  // disposed (M4b.15g). The canvas waits for it.
  const [engine, setEngine] = useState<LayoutEngine>();
  useEffect(() => {
    const made = createLayoutEngine({ worker: layoutWorker });
    setEngine(made);
    return () => made.dispose();
  }, [layoutWorker]);
  // The prototype bands the system level, quiets its "uses code" lines, and draws its own cards
  // (M10.3a, M10.3b2, M10.3b3).
  const prototype = design === "prototype";
  const cache = useMemo(
    () =>
      engine &&
      createLayoutCache(index, engine, undefined, marks, {
        bands: prototype,
        quietCode: prototype,
        cards: prototype,
      }),
    [index, engine, marks, prototype],
  );
  // The filters (M4b.8b): nodes and confidence levels, and connection kinds (imports off).
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<EdgeKind>>(() =>
    initialHiddenKinds ? new Set(initialHiddenKinds) : DEFAULT_HIDDEN_KINDS,
  );
  /** Every node the filters leave off the canvas. */
  const filtered = useMemo(() => hiddenNodes(index, filters), [index, filters]);
  const options = useMemo(() => filterOptions(index), [index]);
  const kindsOff = [...hiddenKinds].filter((k) => !DEFAULT_HIDDEN_KINDS.has(k)).length;
  const filterCount = activeFilterCount(filters) + kindsOff;
  // The prototype's bar counts only what the reader set (M10-design A7), not the default hiding.
  const barFilterCount = prototype ? readerFilterCount(filters) + kindsOff : filterCount;
  /** Connections the filters take off, beyond the kinds hidden by default. */
  const linesOff = useMemo(() => {
    const confidence = new Set(filters.confidence);
    return graph.edges.filter((e) =>
      hiddenKinds.has(e.kind)
        ? !DEFAULT_HIDDEN_KINDS.has(e.kind)
        : confidence.has(e.confidence) || filtered.has(e.from) || filtered.has(e.to),
    ).length;
  }, [graph, filters, hiddenKinds, filtered]);
  const [filtering, setFiltering] = useState(false);
  const filtersState = usePresence(filtering);
  /** Where the popover opened from: the top bar's button, or the canvas (chip or button). */
  const [filtersFrom, setFiltersFrom] = useState<"top" | "canvas">("top");
  const filtersOpener = useRef<HTMLElement | null>(null);
  // The prototype overview's "Try this" offers the system level's hub (M10.3c3), the one its
  // first view frames: worked out on the closed level, whatever is broken down now.
  const hub = useMemo(() => {
    if (!prototype) return undefined;
    const id = hubOf(buildView(shownIndex, [], { filters, hiddenKinds }));
    return id === undefined ? undefined : shownIndex.byId.get(id);
  }, [prototype, shownIndex, filters, hiddenKinds]);
  // The prototype's Analysis notes (M10.3c3): collapsed until opened, here or from Ctrl K.
  const [notesOpen, setNotesOpen] = useState(false);

  const [selected, setSelected] = useState<string | null>(initialSelected);
  /** `traceStart`, if it's in this graph and has somewhere to go. */
  const traceStartNode = traceStart === undefined ? undefined : shownIndex.byId.get(traceStart);
  const fallbackStart =
    traceStartNode && canTraceFrom(shownIndex, traceStartNode) ? traceStartNode.id : undefined;
  // The trace's start outlives the trace, so focus can go back to it on exit.
  const [traced, setTraced] = useState<string | null>(() => {
    const linked = initialTrace === null ? undefined : index.byId.get(initialTrace);
    if (linked && canTraceFrom(index, linked)) return linked.id;
    // The prototype's suggested traces can start in code (M10.3d1), so its links can too.
    if (linked && prototype && hasHops(index, linked)) return linked.id;
    return fallbackStart !== undefined && initialStep !== null ? fallbackStart : null;
  });
  const [stepAsked, setStep] = useState<number | null>(traced === null ? null : (initialStep ?? 0));
  // A new graph without the traced node ends the trace rather than throwing.
  const path = useMemo(
    () => (traced && shownIndex.byId.has(traced) ? traceFrom(shownIndex, traced) : undefined),
    [shownIndex, traced],
  );
  const steps = path?.steps ?? [];
  // A new graph with a shorter path keeps the trace on its last step, and that
  // step is stored, so a graph that lengthens the path again stays on it (M4b.16).
  const step = stepAsked === null ? null : Math.max(0, Math.min(stepAsked, steps.length - 1));
  if (step !== stepAsked) setStep(step);
  // A trace started at the system level opens its path in the prototype (M10.3d2, M10-design
  // B1): the drill-down state it started from, to go back to when it ends, and the frames shown
  // whole again ("+ N more"; `all` after "Show everything").
  const [pathOpened, setPathOpened] = useState<{
    from: Expansion;
    whole: ReadonlySet<string> | "all";
  } | null>(null);
  const pathNodes = useMemo(() => path && traceNodes(path), [path]);
  const pathEnded = step === null || path === undefined;
  const only = useMemo(
    () =>
      pathOpened && pathOpened.whole !== "all" && pathNodes && !pathEnded
        ? { path: pathNodes, whole: pathOpened.whole }
        : undefined,
    [pathOpened, pathNodes, pathEnded],
  );
  const drill = useDrill(index, initialOpen, { filters, hiddenKinds, only });
  const view = drill.view;
  const [playing, setPlaying] = useState(false);
  // The picker T and the Trace button open when there's nothing to trace yet.
  const choices = useMemo(() => traceChoices(shownIndex), [shownIndex]);
  // The prototype's suggested traces (M10.3d1, M10-design B11): the picker's first section, and
  // the first one is "Try this"'s trace.
  const suggested = useMemo(
    () => (prototype ? suggestTraces(shownIndex) : undefined),
    [prototype, shownIndex],
  );
  const [picking, setPicking] = useState(false);
  const pickerState = usePresence(picking);
  // The Ctrl+K palette (M4b.7), over every node.
  // The prototype's Ctrl K also finds the Analysis notes (M10-design A8), its warnings chip gone.
  const entries = useMemo(
    () => [
      ...(prototype ? notesEntries(shownIndex.root, graph.warnings.length) : []),
      ...searchEntries(shownIndex),
    ],
    [shownIndex, prototype, graph.warnings.length],
  );
  const [searching, setSearching] = useState(false);
  const searchState = usePresence(searching);
  /** Where focus was when the picker or the palette opened, to go back to. */
  const dialogOpener = useRef<HTMLElement | null>(null);
  // "⌘ K" on Apple keyboards; read after mount, so a server render matches the first client one.
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);
  const [legend, setLegend] = useState(false);
  const legendState = usePresence(legend);
  // The prototype's minimap is off until the reader turns it on (M10.3c2), so the first view
  // has no overlay over a box.
  const [minimapOn, setMinimapOn] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [shown, setShown] = useState<Shown>();
  // Export (M4b.10b): what's drawn, at the layout it was drawn at. In diff
  // mode, only the version shown, and the Overlay's as head (M6.11e).
  const exportIndex = useMemo(
    () =>
      overlay && version === "overlay" ? buildHierarchy(versionGraph(overlay, "head")) : shownIndex,
    [overlay, version, shownIndex],
  );
  const exported = useMemo(() => {
    if (!shown) return undefined;
    if (!overlay || !compareBase) return viewExport(index, shown);
    const drawn = version === "base" ? "base" : "head";
    return viewExport(index, shown, {
      version: drawn,
      index: exportIndex,
      repo: drawn === "base" ? compareBase.repo : graph.repo,
      note: EXPORT_NOTES[version],
    });
  }, [index, shown, overlay, compareBase, version, exportIndex, graph]);
  useEffect(() => {
    if (exportRef) exportRef.current = exported;
  }, [exportRef, exported]);
  const [runsIn, setRunsIn] = useState<LayoutEngine["runsIn"]>();

  // The camera (M4b.4): fitted to each level until the user pans or zooms,
  // then theirs until they fit again (0 or the fit button).
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCanvas({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const size: Size = shown?.layout ?? { width: 0, height: 0 };
  const [handSet, setHandSet] = useState<Camera | null>(null);
  // Ending a trace that opened its path, however it ends (Esc, T, the chip, a version without
  // it), goes back to the level it started from, the camera the explorer's again (a glide back).
  if (pathOpened && pathEnded) {
    setPathOpened(null);
    drill.set(pathOpened.from);
    setHandSet(null);
  }
  // 0 and the fit button show the whole level (its busiest part when it
  // doesn't fit even at 40%, M5.13b2), until the next drill-down or close;
  // else the explorer frames the node broken down last when the level is too
  // big to read whole (M4b.15f).
  const [overview, setOverview] = useState(false);
  // Memoized: a level too big to fit searches its boxes for the window to
  // frame (`fitLevel`, quadratic in boxes), and the explorer re-renders on
  // every hover.
  const focus = lastOpened(drill.expansion, shown);
  // While the first-visit hint shows, that camera fits below its card
  // (`belowBand`, M9.2g): the card's bottom plus a gap, in canvas px.
  const [hintBand, setHintBand] = useState(0);
  // The prototype's overlays on the canvas (M10.3c2), which its first view keeps boxes out
  // from under: measured before paint, in canvas px.
  const [overlayRects, setOverlayRects] = useState<readonly Rect[]>([]);
  const auto = useMemo(() => {
    const picked = belowBand(canvas, hintBand, (room) =>
      overview && shown
        ? fitLevel(shown.layout, room)
        : autoCamera(shown, room, focus, { firstView: prototype }),
    );
    if (!prototype || !shown || overview || focus !== undefined) return picked;
    const hub = hubOf(shown.view);
    const keep = hub === undefined ? undefined : shown.layout.boxes.find((b) => b.id === hub);
    return clearOfOverlays(picked, shown.layout, canvas, overlayRects, keep);
  }, [overview, shown, canvas, focus, hintBand, prototype, overlayRects]);
  const camera = handSet ?? auto;
  const [cameraMotion, setCameraMotion] = useState<CameraMotion>("layout");
  const live = useRef({ camera, size, canvas });
  live.current = { camera, size, canvas };
  /** Moves the camera by hand, keeping part of the diagram in view. */
  function moveCamera(next: Camera, motion: CameraMotion) {
    const { size: diagram, canvas: room, camera: now } = live.current;
    const kept = keepInView(next, diagram, room);
    if (sameCamera(kept, now) && handSet !== null) return;
    setCameraMotion(motion);
    setHandSet(kept);
  }
  function fitView() {
    setCameraMotion("standard");
    setOverview(true);
    setHandSet(null);
  }
  const zoomBy = (direction: 1 | -1) =>
    moveCamera(stepZoom(live.current.camera, direction, live.current.canvas), "standard");
  useCanvasGestures(canvasRef, live, moveCamera);
  // The first fit is drawn as is; only later moves glide (explorer.css), so
  // the diagram doesn't zoom out on load. A start zoom replaces that fit
  // before anything glides.
  const [settled, setSettled] = useState(false);
  const fitted = canvas.width > 0 && shown !== undefined;
  const startZoom = useRef(initialZoom);
  useEffect(() => {
    if (!fitted || settled) return;
    const zoom = startZoom.current;
    if (zoom !== undefined) {
      startZoom.current = undefined;
      const { size: diagram, canvas: room } = live.current;
      const middle = { x: diagram.width / 2, y: diagram.height / 2 };
      const start = centerOn({ zoom: clampZoom(zoom), x: 0, y: 0 }, middle, room);
      setHandSet(keepInView(start, diagram, room));
    }
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [fitted, settled]);
  // What the canvas culls to: the view, and while the camera glides, where it glides from too.
  const onScreen = useGlideSpan(
    canvas.width > 0 ? visibleRect(camera, canvas) : undefined,
    cameraMotion,
    settled,
  );

  /**
   * A new layout: a camera the explorer picks refits or reframes with it
   * (`autoCamera`; a drill-down or close ends the overview 0 asked for); a
   * hand-set one moves so the node just broken down or closed keeps its
   * corner where it was, gliding with the boxes.
   */
  function onLayout(next: Shown) {
    const prev = shown;
    setShown(next);
    setRunsIn(engine?.runsIn);
    setCameraMotion("layout");
    if (!prev) return;
    const toggled = toggledBetween(prev.view, next.view)[0];
    if (handSet === null) {
      if (toggled !== undefined) setOverview(false);
      return;
    }
    const before = prev.layout.boxes.find((b) => b.id === toggled);
    const after = next.layout.boxes.find((b) => b.id === toggled);
    if (before && after) setHandSet((c) => c && holdInPlace(c, before, after));
  }

  // A connection picked in the inspector: once its level is drawn, fly to it
  // if it's off the canvas (UX.md "selecting flies there, drilling if needed").
  // A palette pick or a changes-list row also zooms in until it's readable
  // and moves focus to its box, so the keys go on from there. The ask is
  // state, not a ref: a click can come before an earlier render's effects
  // have run, and that pass, on the level before the pick, would use it up
  // without a box to focus (M5C.3a3, as M5.16b1).
  const [flyTo, setFlyTo] = useState<{ id: string; zoomIn: boolean } | null>(null);
  useEffect(() => {
    if (!flyTo || !shown || shown.view !== view) return;
    setFlyTo(null);
    const { id, zoomIn } = flyTo;
    if (zoomIn) boxElement(rootRef.current, id)?.focus({ preventScroll: true });
    const box = shown.layout.boxes.find((b) => b.id === id);
    if (!box) return;
    const { camera: now, canvas: room } = live.current;
    const next = zoomIn ? zoomToBox(now, box, room) : ensureVisible(now, box, room);
    if (next !== now) moveCamera(next, "layout");
  });

  const tracing = step !== null && path !== undefined;
  const current: TraceStep | undefined = tracing ? steps[step] : undefined;
  /** The boxes holding each node on the path, at the current depth. */
  const pathBoxes = useMemo(
    () => holders(index, view, filtered, tracing ? traceNodes(path) : []),
    [tracing, path, index, view, filtered],
  );
  // What a deep link keeps (M4b.9): reported when it changes, not on the first render.
  const openNow = new Set(view.open);
  const linkState: ExplorerState = {
    version: overlay ? version : "overlay",
    open: drill.expansion.filter((id) => openNow.has(id)),
    selected,
    trace: tracing ? traced : null,
    step: tracing ? step : null,
    filters,
    hiddenKinds: [...hiddenKinds].sort(compareStrings),
  };
  const linkKey = encodeState(linkState);
  const reportedKey = useRef(linkKey);
  useEffect(() => {
    if (reportedKey.current === linkKey) return;
    reportedKey.current = linkKey;
    onStateChange?.(linkState);
  });

  const hopIds = useMemo(() => new Set(steps.map((s) => s.edge.id)), [steps]);
  /** The current hop's two ends as drawn: the boxes holding them (one box for a hop inside it). */
  const hopBoxes = useMemo(
    () => holders(index, view, filtered, current ? [current.from.id, current.to.id] : []),
    [current, index, view, filtered],
  );
  /** The box the current hop leaves from, which sets the pulse's direction. */
  const hopStart = current ? drawnAs(index, view, filtered, current.from.id) : undefined;

  // A trace's start and each step frame the current hop's two ends at a
  // readable size if they aren't both on the canvas at one (`frameHop`,
  // M4b.15f), clear of the minimap and below the first-visit hint's card
  // while it shows (M9.7f, as the first view is), after the first fit and on the drawn
  // layout: once per step, and again when Play starts or a new layout lands
  // (a drill-down mid-trace, which otherwise left both ends off the canvas,
  // M9.3c). The camera slides toward the rest of the path as far as the hop
  // stays framed, so a path that fits is shown whole (M9.7h). An open frame
  // holding an end is left out: it's the closed boxes that light up.
  const [playAsked, setPlayAsked] = useState(0);
  const framedHop = useRef<{ key: string; drawn: Shown["view"] } | null>(null);
  useEffect(() => {
    if (!tracing || !current) {
      framedHop.current = null;
      return;
    }
    const key = `${traced ?? ""}\n${step}\n${playAsked}`;
    if (!settled || shown?.view !== view) return;
    if (framedHop.current?.key === key && framedHop.current.drawn === shown.view) return;
    framedHop.current = { key, drawn: shown.view };
    const closed = (ids: Set<string>) => [...ids].filter((id) => !view.byId.get(id)?.open);
    const rect = boxesRect(shown.layout.boxes, closed(hopBoxes));
    if (!rect) return;
    const whole = boxesRect(shown.layout.boxes, closed(pathBoxes));
    const { camera: now, canvas: room } = live.current;
    const next = frameHop(now, rect, room, minimapRect(), hintBand, whole);
    if (next !== now) moveCamera(next, "layout");
  });

  // The prototype's overlays (chips, the hint line, the toolbar; not the minimap or legend the
  // reader opens): measured after every render, kept when unchanged.
  useLayoutEffect(() => {
    if (!prototype) return;
    const on = canvasRef.current?.getBoundingClientRect();
    if (!on) return;
    const rects = [
      ...(rootRef.current?.querySelectorAll(
        '.gi-explorer__pin > :is(.gi-status, .gi-explorer__diff, .gi-hint-line:not([data-state="closing"]), .gi-toolbar)',
      ) ?? []),
    ].map((el) => {
      const at = el.getBoundingClientRect();
      return {
        x: Math.round(at.left - on.left),
        y: Math.round(at.top - on.top),
        width: Math.round(at.width),
        height: Math.round(at.height),
      };
    });
    const key = (list: readonly Rect[]) => JSON.stringify(list);
    setOverlayRects((now) => (key(now) === key(rects) ? now : rects));
  });

  /** Where the minimap is on the canvas, in canvas px (0 × 0 when it isn't drawn). */
  function minimapRect(): Rect {
    const map = rootRef.current?.querySelector(".gi-minimap");
    const on = canvasRef.current?.getBoundingClientRect();
    const at = map?.getBoundingClientRect();
    if (!on || !at) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: at.left - on.left, y: at.top - on.top, width: at.width, height: at.height };
  }

  // The player: each step stays up for PLAY_STEP_MS, and play stops on the last.
  useEffect(() => {
    if (!playing || step === null) return;
    if (step >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep(step + 1), PLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, step, steps.length]);

  // Starting, stepping, or ending a trace can remove the focused control (the
  // step player's buttons, "Trace from here", a disabled "Next step"), which
  // drops focus to the page and makes T and Esc stop working. Put it back: on
  // the current step while tracing, else on the box the trace started from.
  const lastTrace = useRef({ tracing, step });
  useEffect(() => {
    const prev = lastTrace.current;
    lastTrace.current = { tracing, step };
    if (prev.tracing === tracing && prev.step === step) return; // first render: don't take focus
    const root = rootRef.current;
    const active = document.activeElement;
    const lost =
      !active || active === document.body || !active.isConnected || active.matches(":disabled");
    if (!root || !lost) return;
    if (tracing) {
      root.querySelector<HTMLElement>(".gi-explorer__step[aria-current]")?.focus();
      return;
    }
    const start = traced ? drawnAs(index, view, filtered, traced) : undefined;
    if (start) boxElement(root, start)?.focus();
  }, [tracing, step, traced, index, view, filtered]);

  const selectedNode = selected ? index.byId.get(selected) : undefined;
  /** Whether the selection is a page or route with a request path. */
  const selectionTraces = selectedNode !== undefined && canTraceFrom(shownIndex, selectedNode);
  /** What T and the Trace button trace: the selection if it can be, else `traceStart`. */
  const startable = selectionTraces ? selectedNode.id : fallbackStart;
  const selectedBox = selected ? drawnAs(index, view, filtered, selected) : undefined;
  /** Boxes the canvas draws even when culled (M4b.13a): focus goes back to these. */
  const traceStartBox = traced ? drawnAs(index, view, filtered, traced) : undefined;
  const keptBoxes = useMemo(
    () => [selectedBox, traceStartBox].filter((id): id is string => id !== undefined),
    [selectedBox, traceStartBox],
  );
  const repo: RepoRef = graph.repo;

  // First-visit hints (M4b.12a, UX.md "Onboarding"): chosen once from what
  // the explorer opened with, after mount, so a server render (no storage)
  // matches the first client one. Kept while the last one plays its exit.
  const [hints, setHints] = useState<{ steps: readonly HintStep[]; at: number } | null>(null);
  // The prototype's one line instead (M10.3c2, `hintLine`).
  const [hintParts, setHintParts] = useState<readonly string[] | null>(null);
  const [hintsOn, setHintsOn] = useState(false);
  const hintState = usePresence(hintsOn);
  const hintStart = useRef({
    canBreakDown: [...view.byId.values()].some((n) => n.canOpen && !n.open),
    opened: view.open.length > 0,
    selected: selected !== null,
    canTrace: startable !== undefined || choices.length > 0,
    tracing,
  });
  const hintsChecked = useRef(false);
  useEffect(() => {
    if (hintsChecked.current || !onboarding) return;
    hintsChecked.current = true;
    if (onboarding.done()) return;
    if (prototype) {
      const parts = hintLine(hintStart.current);
      if (parts.length === 0) return;
      setHintParts(parts);
      setHintsOn(true);
      return;
    }
    const steps = hintSteps(hintStart.current);
    if (steps.length === 0) return;
    setHints({ steps, at: 0 });
    setHintsOn(true);
  }, [onboarding, prototype]);

  // The card's room (`hintBand`): measured before paint, so the first fit is
  // already below it; the tallest of its tips so far, so Next doesn't move
  // the diagram back and forth; none from the moment it starts closing.
  const [hintPin, setHintPin] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!hintsOn || !hintPin) {
      setHintBand(0);
      return;
    }
    const measure = () =>
      setHintBand((band) => Math.max(band, hintPin.offsetTop + hintPin.offsetHeight + HINT_GAP));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(hintPin);
    return () => observer.disconnect();
  }, [hintsOn, hintPin]);

  /** Next (or Done): the next hint, or, after the last, none, remembered. */
  function nextHint() {
    if (!hints) return;
    if (hints.at + 1 < hints.steps.length) setHints({ ...hints, at: hints.at + 1 });
    else endHints(true);
  }

  /**
   * Hides the hints: for good (`remember`: Done, "Don't show again"), or for
   * this visit (the close button, Esc). Focus inside goes to the selection's
   * box or the first box, so the keys go on working.
   */
  function endHints(remember: boolean) {
    if (remember) onboarding?.remember();
    const root = rootRef.current;
    if (root?.querySelector(".gi-hint")?.contains(document.activeElement)) {
      const box = selectedBox ? boxElement(root, selectedBox) : null;
      (
        box ?? root.querySelector<HTMLElement>(".gi-drill__node:not([data-leaving]) > .gi-node")
      )?.focus();
    }
    setHintsOn(false);
  }

  /**
   * The reader did what a hint says: if it's the one showing, it moves on. The prototype's line
   * goes, for good, at the first break-down, trace, or search (M10-design B2).
   */
  function hintDone(step: HintStep | "search") {
    if (prototype) {
      if (hintsOn && step !== "select") endHints(true);
      return;
    }
    if (hintsOn && hints?.steps[hints.at] === step) nextHint();
  }

  /**
   * Diff mode's Base, Head, or Overlay from the top bar (or the canvas), said aloud. The
   * selection and a trace stay when the version has their node (a trace then
   * follows that version's connections); otherwise they go, and it says so.
   */
  function showVersion(next: DiffView) {
    setVersion(next);
    const has = (id: string) => next === "overlay" || (overlay?.nodesIn[next].has(id) ?? true);
    const said = [`Showing ${VERSION_TEXT[next]}`];
    if (tracing && traced !== null && !has(traced)) {
      setStep(null);
      setPlaying(false);
      said.push(`The trace from ${nodeOf(index, traced).label} ended: it isn't in this version`);
    }
    if (selected !== null && !has(selected)) {
      setSelected(null);
      said.push(`${nodeOf(index, selected).label} isn't in it, so it's no longer selected`);
    }
    setAnnouncement(said.join(". "));
  }

  /** Selects a node (or none), saying what it connects to (UX.md). */
  function select(id: string | null) {
    setSelected(id);
    if (id) {
      setAnnouncement(selectionAnnouncement(index, id, hiddenKinds));
      hintDone("select");
    } else if (selected) setAnnouncement("Selection cleared");
  }

  // The warnings chip (M4b.12b): the repo overview, which lists them, with
  // focus on its warnings once it's drawn. The ask is state, not a ref read
  // by every effect pass: a click can come before an earlier render's
  // effects have run (a loaded machine), and that pass, with the selection's
  // inspector still up, would use it up (M5.16b1).
  const [warningsAsked, setWarningsAsked] = useState(0);
  const focusWarnings = () =>
    rootRef.current
      ?.querySelector<HTMLElement>(`.gi-inspector [data-section="${WARNINGS_SECTION}"]`)
      ?.focus();
  function showWarnings() {
    setNotesOpen(true);
    // The overview is already up: its section is there, so focus it now.
    if (selected === null) {
      focusWarnings();
      return;
    }
    setWarningsAsked((n) => n + 1);
    select(null);
  }
  useEffect(() => {
    if (warningsAsked > 0) focusWarnings();
  }, [warningsAsked]);

  /**
   * A box focused from the keyboard (Tab, an arrow key, focus put back after
   * a change): the camera glides to it if it isn't wholly on the canvas, once
   * the box's layout is the one drawn (focus put back after breaking down
   * comes before the explorer has the new layout). A click's focus leaves
   * the camera alone, so a box half off the edge doesn't jump away from the
   * pointer. So does focus put back on the node just broken down while
   * tracing: the trace frames the current step on the new layout instead,
   * which the frame's corner would pan away from (M9.3c).
   */
  const [focusedBox, setFocusedBox] = useState<{ id: string } | null>(null);
  function followFocus(target: EventTarget) {
    if (!(target instanceof HTMLElement) || !target.matches(".gi-drill__node > .gi-node")) return;
    const id = target.parentElement?.dataset.nodeId;
    if (id !== undefined && keyboardFocus(target)) setFocusedBox({ id });
  }
  useEffect(() => {
    if (!focusedBox || shown?.view !== view) return;
    setFocusedBox(null);
    if (tracing && focusedBox.id === focus && view.byId.get(focus)?.open) return;
    const box = shown.layout.boxes.find((b) => b.id === focusedBox.id);
    if (!box) return;
    const { camera: now, canvas: room } = live.current;
    const next = ensureVisible(now, box, room);
    if (next !== now) moveCamera(next, "standard");
  });

  function breakDown(id: string) {
    const n = view.byId.get(id);
    if (!n?.canOpen || n.open) return;
    drill.open(id);
    setAnnouncement(`Broke down ${n.node.label}`);
    hintDone("zoom");
  }

  function goUp(): boolean {
    const closed = drill.up();
    if (closed === undefined) return false;
    const parent = view.byId.get(closed)?.parent;
    setAnnouncement(`Back to ${parent ? nodeOf(index, parent).label : index.root.label}`);
    return true;
  }

  function goTo(id: string) {
    drill.collapseTo(id);
    setAnnouncement(`Back to ${nodeOf(index, id).label}`);
  }

  /**
   * Takes off the filters that hide a node (`filtersShowing`), so it's drawn
   * again; the chip and the Filters count show what's left. Says so.
   * Returns the filters it's shown under.
   */
  function showNode(id: string): Filters {
    if (!filtered.has(id)) return filters;
    const next = filtersShowing(index, filters, id);
    refocus.current = next;
    setFilters(next);
    setAnnouncement(`Changed the filters to show ${nodeOf(index, id).label}`);
    return next;
  }

  /** Clear: shows everything the filters hide. Connection kinds hidden by default stay as they are. */
  function clearFilters() {
    setFilters(NO_FILTERS);
    setHiddenKinds(new Set([...hiddenKinds].filter((k) => DEFAULT_HIDDEN_KINDS.has(k))));
    setAnnouncement("Filters cleared");
  }

  /** The top bar's Filters button, the filters chip, or the canvas's Filters button: open or close the popover. */
  function toggleFilters(from: "top" | "canvas") {
    if (filtering) {
      closeFilters();
      return;
    }
    filtersOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFiltersFrom(from);
    setFiltering(true);
  }

  /**
   * Closes the popover; focus inside it goes back to what opened it (the
   * button or chip it opened from, when the page had focus), unless `stay`
   * (a press elsewhere put it there).
   */
  function closeFilters(stay = false) {
    const root = rootRef.current;
    const opener = filtersOpener.current;
    filtersOpener.current = null;
    const inside = root?.querySelector(".gi-filters")?.contains(document.activeElement);
    const back =
      opener?.isConnected && opener !== document.body
        ? opener
        : root?.querySelector<HTMLElement>(
            filtersFrom === "top" ? ".gi-topbar__filters" : "[data-filters-opener]",
          );
    if (!stay && inside && back) back.focus();
    else if (inside && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setFiltering(false);
  }

  // Showing a hidden node removes the button that did it (Show on canvas, a
  // step's Show), which drops focus to the page. Once the canvas is drawn,
  // put it on the current step while tracing, else on the selection's box.
  // Holds the filters it was shown under: only a render with them has
  // removed the button. An earlier render's effects can still run after the
  // click, with the button focused, and mustn't take that as focus kept
  // (M5.17b3).
  const refocus = useRef<Filters | null>(null);
  useEffect(() => {
    if (refocus.current !== filters) return;
    const root = rootRef.current;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!root || !lost) {
      refocus.current = null;
      return;
    }
    if (tracing) {
      const current = root.querySelector<HTMLElement>(".gi-explorer__step[aria-current]");
      if (current) {
        refocus.current = null;
        current.focus();
      }
      return;
    }
    // Wait for the new view's boxes: the old layout's may be replaced.
    if (shown?.view !== view) return;
    refocus.current = null;
    const target = selectedBox ? boxElement(root, selectedBox) : null;
    target?.focus();
  });

  // A press outside the popover (and not on what opens it) closes it, leaving focus where the press put it.
  const closeOnPress = useRef(closeFilters);
  closeOnPress.current = closeFilters;
  useEffect(() => {
    if (!filtering) return;
    const onPress = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".gi-filters, .gi-topbar__filters, [data-filters-opener]")) return;
      closeOnPress.current(true);
    };
    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [filtering]);

  /** Starts tracing the request path from a node, at its first step, showing it if the filters hide it. */
  function startTrace(id: string) {
    const shownUnder = showNode(id);
    // From the system level (or from a path a trace opened), the prototype opens the new path.
    const from = pathOpened?.from ?? (view.open.length === 0 ? drill.expansion : undefined);
    if (prototype && from !== undefined && shownIndex.byId.has(id)) {
      const opens = openForPath(
        shownIndex,
        traceFrom(shownIndex, id),
        hiddenNodes(index, shownUnder),
      );
      if (opens.length > 0) {
        setPathOpened({ from, whole: new Set() });
        drill.set(opens);
        setHandSet(null);
      } else if (pathOpened) {
        setPathOpened(null);
        drill.set(pathOpened.from);
      }
    }
    setTraced(id);
    setStep(0);
    setPlaying(false);
    setAnnouncement(`Tracing from ${nodeOf(index, id).label}`);
    hintDone("trace");
  }

  /**
   * A path-only frame's "+ N more": that frame shows whole again. Focus goes from the button,
   * which goes, to the frame.
   */
  function showMore(id: string) {
    setPathOpened((o) => (o && o.whole !== "all" ? { ...o, whole: new Set([...o.whole, id]) } : o));
    boxElement(rootRef.current, id)?.focus({ preventScroll: true });
    setAnnouncement(`Showing everything in ${nodeOf(index, id).label}`);
  }

  /** The trace chip's "Show everything": every frame the path opened shows whole; focus stays in the chip. */
  function showEverything() {
    setPathOpened((o) => o && { ...o, whole: "all" });
    rootRef.current
      ?.querySelector<HTMLElement>('.gi-status[data-tone="trace"] [data-icon-only]')
      ?.focus();
    setAnnouncement("Showing everything inside the traced services");
  }

  /**
   * T and the Trace button: end the trace, start one from {@link startable},
   * or, with nothing to start from, open the picker.
   */
  function toggleTrace() {
    if (tracing) {
      setStep(null);
      setPlaying(false);
      setAnnouncement("Trace ended");
    } else if (startable) startTrace(startable);
    else {
      rememberOpener();
      setPicking(true);
    }
  }

  function rememberOpener() {
    dialogOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  /**
   * Focus out of a closing picker or palette: back where it was when it
   * opened (the Trace button, a box), unless `stay` (something else takes it).
   */
  function leaveDialog(stay = false) {
    const opener = dialogOpener.current;
    dialogOpener.current = null;
    if (!stay && opener?.isConnected && opener !== document.body) opener.focus();
    // Nothing to go back to: leave the closing (inert) field, so a trace's
    // first step or the picked box can take focus instead of the page.
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** Closes the picker, focus back where it was when it opened. */
  function closePicker() {
    leaveDialog();
    setPicking(false);
  }

  /** Ctrl+K, ⌘K, or the top bar's search field: open the palette, or close it. */
  function toggleSearch() {
    if (searching) closeSearch();
    else if (!picking) {
      rememberOpener();
      setSearching(true);
      hintDone("search");
    }
  }

  function closeSearch() {
    leaveDialog();
    setSearching(false);
  }

  /** A palette result: drill until it's a box, select it, fly there (zooming in to read it), and focus it (UX.md). */
  function pickSearch(id: string) {
    leaveDialog(true);
    setSearching(false);
    if (id === NOTES_ENTRY) showWarnings();
    else reveal(id, true);
  }

  /**
   * A changes-list row (M6.9d): fly to its node like a palette pick. In Base
   * or Head, a node that version doesn't have (a removed route in Head) is
   * shown on the overlay, and that's said.
   */
  function pickChange(id: string) {
    const missing = overlay && version !== "overlay" && !overlay.nodesIn[version].has(id);
    if (missing) setVersion("overlay");
    reveal(id, true);
    if (missing) {
      setAnnouncement(
        `Showing ${VERSION_TEXT.overlay}: ${nodeOf(index, id).label} isn't in ${VERSION_TEXT[version]}. ${selectionAnnouncement(index, id, hiddenKinds)}`,
      );
    }
  }

  // Ctrl+K with focus on the page itself (nothing focused yet) opens it too.
  const searchKey = useRef(toggleSearch);
  searchKey.current = toggleSearch;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const onPage = event.target === document.body || event.target === document.documentElement;
      if (!onPage || event.defaultPrevented || !isSearchKey(event)) return;
      event.preventDefault();
      searchKey.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** A page or route picked in the picker: trace it. */
  function pickTrace(id: string) {
    closePicker();
    startTrace(id);
  }

  /** Play or pause the steps; play on the last step starts over. */
  function togglePlay() {
    if (playing) setPlaying(false);
    else {
      if (step !== null && step >= steps.length - 1) setStep(0);
      setPlaying(true);
      setPlayAsked((n) => n + 1);
    }
  }

  /** A step picked by hand (Previous, Next, the list) takes over from the player. */
  function goToStep(next: number) {
    setPlaying(false);
    setStep(next);
  }

  /** Closes the legend; focus inside it goes back to the button that opened it. */
  function closeLegend() {
    const root = rootRef.current;
    const toggle = root?.querySelector<HTMLElement>(
      prototype ? "[data-legend-opener]" : ".gi-explorer__map .gi-overlay button",
    );
    if (root?.querySelector(".gi-legend")?.contains(document.activeElement)) toggle?.focus();
    setLegend(false);
  }

  /**
   * Esc: close the palette, the picker, or the legend → exit trace → go up a
   * level → clear selection (UX.md keyboard table). T toggles trace, Ctrl+K
   * or ⌘K the palette.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isSearchKey(event)) {
      toggleSearch();
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // A dialog's field handled it (its Esc closes only the dialog).
    if (event.defaultPrevented) return;
    if (event.key === "+" || event.key === "=" || event.key === "-" || event.key === "0") {
      if (isTextEntry(event.target)) return;
      if (event.key === "0") fitView();
      else zoomBy(event.key === "-" ? -1 : 1);
      event.preventDefault();
    } else if (event.key === "Escape") {
      // Esc in a hint closes the hints (for this visit), nothing else.
      if (hintsOn && event.target instanceof Element && event.target.closest(".gi-hint")) {
        endHints(false);
      } else if (searching) closeSearch();
      else if (picking) closePicker();
      else if (filtering) closeFilters();
      else if (legend) closeLegend();
      else if (tracing) toggleTrace();
      else if (goUp()) {
        // went up a level
      } else if (selected) select(null);
      else return;
      event.preventDefault();
    } else if (event.key === "t" || event.key === "T") {
      // A T typed in the picker's field is text (and mustn't make the field the picker's opener).
      if (isTextEntry(event.target)) return;
      toggleTrace();
      event.preventDefault();
    }
  }

  /**
   * A connection in the inspector or a palette pick: show it if the filters
   * hide it, drill until it's a box, and select it (UX.md). `zoomIn` (a
   * palette pick, a changes-list row) also zooms in to read it and focuses it.
   */
  function reveal(id: string, zoomIn = false) {
    const shownUnder = showNode(id);
    setFlyTo({ id, zoomIn });
    drill.reveal(id, shownUnder);
    select(id);
  }

  /**
   * While tracing: the current hop's boxes are `current`, the rest of the
   * path `traced`, an open frame holding part of it plain, everything else
   * dimmed. The selection is drawn either way. In diff mode's Overlay each
   * box shows its state and, closed, the changes inside it; Base and Head
   * leave out what the version doesn't have, in place.
   */
  const boxLook = (n: ViewNode): BoxLook => ({
    ...(overlay && version === "overlay"
      ? { diff: overlay.nodes.get(n.id), changes: overlay.inside.get(n.id) }
      : {}),
    ...(overlay && version !== "overlay" ? { absent: !overlay.nodesIn[version].has(n.id) } : {}),
    selected: selectedBox === n.id,
    emphasis: !tracing
      ? undefined
      : hopBoxes.has(n.id) && !n.open
        ? "current"
        : pathBoxes.has(n.id)
          ? "traced"
          : n.open && [...pathBoxes].some((p) => p !== n.id && isWithin(index, p, n.id))
            ? undefined
            : "dimmed",
  });

  /** On the request path: the line is traced and its particles flow. */
  const onPath = (e: ViewEdge) => tracing && e.edges.some((g) => hopIds.has(g.id));

  /**
   * While tracing: the current step's line is `current`, the rest of the path
   * `traced`, everything else dimmed. Otherwise the selection's lines are
   * selected. In diff mode, like the boxes: the Overlay's states and broken
   * connections, or only the lines of the version shown.
   */
  const lineLook = (e: ViewEdge): LineLook => {
    const isHop = current !== undefined && e.edges.some((g) => g.id === current.edge.id);
    const inVersion = overlay && version !== "overlay" ? overlay.edgesIn[version] : undefined;
    return {
      ...(marks && version === "overlay" ? marks.line(e.edges) : {}),
      ...(inVersion ? { absent: !e.edges.some((g) => inVersion.has(g.id)) } : {}),
      selected: !tracing && (selectedBox === e.from || selectedBox === e.to),
      emphasis: !tracing ? undefined : isHop ? "current" : onPath(e) ? "traced" : "dimmed",
      flow: onPath(e),
      // The pulse runs the way the request goes, against the line for a queue's consumer.
      pulse: !isHop ? undefined : e.to === hopStart && e.from !== hopStart ? "backward" : "forward",
    };
  };

  // The prototype's one page bar (M10-design A7): the page's items, and the path in the bar.
  const pageBar = prototype
    ? { variant: "page" as const, home, status: commitStatus, end: topBarEnd }
    : {};
  const crumbsInBar = prototype && topBar;

  const trailEnd = deepestOpen(view, drill.expansion);
  const crumbs = [
    { id: index.root.id, label: index.root.label, kind: index.root.kind },
    // Named as the version shown has them (a renamed folder's base name in Base).
    ...(trailEnd ? viewTrail(view, trailEnd) : []).map((n) => ({
      id: n.id,
      label: (shownIndex.byId.get(n.id) ?? n.node).label,
      kind: n.node.kind,
    })),
  ];

  // The minimap shows the top level of the drawn layout.
  const drawn = shown?.view;
  const minimapNodes = (shown?.layout.boxes ?? []).flatMap((b) =>
    drawn?.byId.get(b.id)?.parent === null
      ? [{ id: b.id, rect: b, layer: layerOf(index, b.id) }]
      : [],
  );

  const selectedView = selectedNode ? view.byId.get(selectedNode.id) : undefined;
  /** What the inspector explains: the selection as the version shown has it, else the repo. */
  const panelNode = (selected ? shownIndex.byId.get(selected) : undefined) ?? shownIndex.root;
  /**
   * Where the inspector reads code (M6.9e1): base's commit and files for what
   * the inspector shows as base recorded it (all of Base; in the Overlay, a
   * node or hop only base has), head's otherwise.
   */
  const codeAt = (fromBase: boolean) =>
    fromBase && compareBase
      ? { repo: compareBase.repo, sources: baseSourceAccess }
      : { repo, sources: sourceAccess };
  const fromBase = (has: ReadonlySet<string> | undefined, id: string | undefined) =>
    overlay !== undefined &&
    (version === "base" || (version === "overlay" && id !== undefined && !has?.has(id)));
  const nodeCode = codeAt(fromBase(overlay?.nodesIn.head, panelNode.id));
  const stepCode = codeAt(
    fromBase(overlay?.edgesIn.head, step === null ? undefined : steps[step]?.edge.id),
  );
  const hint = hints?.steps[hints.at];
  const minimap = (
    <Minimap
      nodes={minimapNodes}
      viewport={
        canvas.width > 0
          ? visibleRect(camera, canvas)
          : { x: 0, y: 0, width: size.width, height: size.height }
      }
      onNavigate={(p) => moveCamera(centerOn(live.current.camera, p, live.current.canvas), "none")}
    />
  );

  /** The popover, under what opened it (the top bar's button, or the canvas's chip or button). */
  const filtersPopover = () =>
    filtersState && (
      <FiltersPopover
        autoFocus
        state={filtersState}
        options={options}
        filters={filters}
        hiddenKinds={hiddenKinds}
        onFiltersChange={setFilters}
        onHiddenKindsChange={setHiddenKinds}
        onClear={filterCount > 0 ? clearFilters : undefined}
        onClose={() => closeFilters()}
      />
    );

  // A diff that doesn't belong to these graphs (ADR-0182): say so where the
  // diagram would be, rather than draw a wrong comparison.
  if (compared?.mismatch !== undefined) {
    return (
      <div ref={rootRef} className="gi-explorer" data-bare={topBar ? undefined : ""} data-empty="">
        {topBar && <TopBar repo={repo} actions={false} {...pageBar} />}
        <div className="gi-explorer__main">
          <div className="gi-explorer__canvas" role="region" aria-label="Diagram">
            <EmptyState tone="error" title="This comparison doesn't match these commits">
              <p>
                The changes couldn&apos;t be drawn because {compared.mismatch}. Nothing was guessed.
              </p>
            </EmptyState>
          </div>
        </div>
      </div>
    );
  }

  // No TypeScript or JavaScript app (UX.md "States"): one card where the
  // diagram would be, with what was skipped and why, instead of an empty
  // service box with nothing to search, filter, or trace.
  if (!hasApp) {
    return (
      <div ref={rootRef} className="gi-explorer" data-bare={topBar ? undefined : ""} data-empty="">
        {topBar && <TopBar repo={repo} actions={false} {...pageBar} />}
        <div className="gi-explorer__main">
          <div className="gi-explorer__canvas" role="region" aria-label="Diagram">
            <EmptyState title="We couldn't find a TypeScript or JavaScript app here">
              <p>GitInside supports React, Next.js, Express, and Prisma in v1.</p>
              {graph.warnings.length > 0 && (
                <section className="gi-empty__section" aria-label="Warnings">
                  <h3>
                    What the analysis skipped
                    <span className="gi-count">
                      {graph.warnings.length.toLocaleString("en-US")}
                    </span>
                  </h3>
                  <WarningList warnings={graph.warnings} />
                </section>
              )}
            </EmptyState>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="gi-explorer"
      data-bare={topBar ? undefined : ""}
      data-design={prototype ? "prototype" : undefined}
      data-layout-runs-in={runsIn}
      data-settled={settled ? "" : undefined}
      data-hand-camera={handSet ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {topBar && (
        <TopBar
          repo={repo}
          mac={mac}
          onSearch={toggleSearch}
          filterCount={barFilterCount}
          filtersOpen={filtering}
          onFilters={() => toggleFilters("top")}
          share={<ShareMenu link={() => linkTo(linkKey)} exports={() => exported} />}
          diff={overlay ? { value: version, onChange: showVersion } : undefined}
          tracing={tracing}
          onTrace={toggleTrace}
          {...pageBar}
          crumbs={crumbsInBar ? crumbs : undefined}
          onCrumb={goTo}
        />
      )}
      <div className="gi-explorer__main">
        <div
          ref={canvasRef}
          className="gi-explorer__canvas"
          role="region"
          aria-label="Diagram"
          onClick={() => select(null)}
          onFocus={(event) => followFocus(event.target)}
        >
          {/* First in the canvas, so Tab meets the hint before the boxes it's about. */}
          {hintState && hint !== undefined && hints && (
            <div
              ref={setHintPin}
              className="gi-explorer__pin"
              data-place="top-center"
              onClick={(e) => e.stopPropagation()}
            >
              <OnboardingHint
                step={hint}
                position={hints.at}
                total={hints.steps.length}
                state={hintState}
                onNext={nextHint}
                onClose={() => endHints(false)}
                onNever={() => endHints(true)}
              />
            </div>
          )}
          <DrillCanvas
            className="gi-explorer__drill"
            data-camera-motion={cameraMotion}
            style={{
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
            }}
            index={index}
            view={view}
            cache={cache}
            onOpen={breakDown}
            onSelect={select}
            boxLook={boxLook}
            lineLook={lineLook}
            onLayout={onLayout}
            zoom={camera.zoom}
            viewport={onScreen}
            keep={keptBoxes}
            cullFrom={cullFrom}
            marks={marks}
            versionIndex={shownIndex === index ? undefined : shownIndex}
            cards={prototype}
            onMore={prototype ? showMore : undefined}
          />
          <div
            className="gi-explorer__pin"
            data-place="top-left"
            onClick={(e) => e.stopPropagation()}
          >
            {overlay && compare && (
              <div className="gi-explorer__diff">
                <StatusChip tone="diff">
                  Comparing {compareName(compare.baseName, compare.base)} →{" "}
                  {compareName(compare.headName, given)}
                </StatusChip>
                {/* Without the top bar (the website), its Base / Head / Overlay go here. */}
                {!topBar && (
                  <div className="gi-overlay gi-explorer__versions">
                    <SegmentedControl
                      label="Diff view"
                      options={DIFF_VIEWS}
                      value={version}
                      onChange={showVersion}
                    />
                  </div>
                )}
              </div>
            )}
            {tracing && (
              <StatusChip tone="trace" exitLabel="Exit trace" onExit={toggleTrace}>
                Tracing <code>{traceName(path.start)}</code>
                {view.nodes.some((n) => n.more) && (
                  <>
                    {" · "}
                    <button type="button" className="gi-status__open" onClick={showEverything}>
                      Show everything
                    </button>
                  </>
                )}
              </StatusChip>
            )}
            {/* The prototype's chip is for what the reader set, never the default hiding. */}
            {(prototype ? barFilterCount > 0 : filtered.size > 0 || linesOff > 0) ? (
              <StatusChip exitLabel="Clear filters" onExit={clearFilters}>
                <button
                  type="button"
                  className="gi-status__open"
                  data-filters-opener=""
                  aria-expanded={filtering}
                  onClick={() => toggleFilters("canvas")}
                >
                  {filtersText(prototype ? barFilterCount : filterCount, filtered.size, linesOff)}
                </button>
              </StatusChip>
            ) : (
              !topBar && (
                <div className="gi-overlay gi-explorer__filters-button">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="filter"
                    data-filters-opener=""
                    aria-expanded={filtering}
                    onClick={() => toggleFilters("canvas")}
                  >
                    Filters
                  </Button>
                </div>
              )
            )}
            {filtersFrom === "canvas" && filtersPopover()}
          </div>
          <div
            className="gi-explorer__pin"
            data-place="top-right"
            onClick={(e) => e.stopPropagation()}
          >
            {!prototype && (
              <ZoomControls
                zoom={camera.zoom}
                onZoomIn={() => zoomBy(1)}
                onZoomOut={() => zoomBy(-1)}
                onFit={fitView}
              />
            )}
            {filtersFrom === "top" && filtersPopover()}
          </div>
          <div
            className="gi-explorer__pin"
            data-place="bottom-left"
            onClick={(e) => e.stopPropagation()}
          >
            {prototype && hintState && hintParts && (
              <HintLine parts={hintParts} state={hintState} />
            )}
            {/* Not while tracing: the inspector is the trace's then. Not in the prototype: its
                panel lists them (M10-design A8). */}
            {!prototype && graph.warnings.length > 0 && !tracing && (
              <StatusChip className="gi-explorer__warnings">
                <button type="button" className="gi-status__open" onClick={showWarnings}>
                  {warningCount(graph.warnings.length)}
                </button>
              </StatusChip>
            )}
            {!crumbsInBar && <Breadcrumbs items={crumbs} onSelect={goTo} />}
          </div>
          <div
            className="gi-explorer__pin"
            data-place="bottom-right"
            onClick={(e) => e.stopPropagation()}
          >
            {legendState && (
              <Legend
                data-state={legendState}
                inert={legendState === "closing" || undefined}
                aria-hidden={legendState === "closing" || undefined}
                onClose={closeLegend}
              />
            )}
            {prototype ? (
              <>
                {minimapOn && minimap}
                <CanvasToolbar
                  zoom={camera.zoom}
                  onZoomIn={() => zoomBy(1)}
                  onZoomOut={() => zoomBy(-1)}
                  onFit={fitView}
                  minimap={minimapOn}
                  onMinimap={() => setMinimapOn(!minimapOn)}
                  legend={legend}
                  onLegend={() => setLegend(!legend)}
                />
              </>
            ) : (
              <div className="gi-explorer__map">
                <div className="gi-overlay">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon="legend"
                    aria-expanded={legend}
                    onClick={() => setLegend(!legend)}
                  >
                    Legend
                  </Button>
                </div>
                {minimap}
              </div>
            )}
          </div>
        </div>
        {tracing ? (
          <TracePanel
            index={shownIndex}
            steps={steps}
            cutOff={path.cutOff}
            step={step}
            view={view}
            sources={stepCode.sources}
            repo={stepCode.repo}
            playing={playing}
            onStep={goToStep}
            onPlay={togglePlay}
            onBreakDown={breakDown}
            filtered={filtered}
            onShow={showNode}
          />
        ) : (
          <NodePanel
            index={shownIndex}
            node={panelNode}
            canBreakDown={selectedView !== undefined && selectedView.canOpen && !selectedView.open}
            canTrace={selectionTraces}
            traceHint={fallbackStart ? nodeOf(shownIndex, fallbackStart) : undefined}
            canPick={choices.length > 0}
            sources={nodeCode.sources}
            repo={nodeCode.repo}
            onSelect={(id) => reveal(id)}
            onBreakDown={breakDown}
            onTrace={startTrace}
            filteredOut={selectedNode !== undefined && filtered.has(selectedNode.id)}
            onShow={showNode}
            warnings={graph.warnings}
            prototype={
              prototype
                ? {
                    hub,
                    suggestion: suggested?.[0],
                    onSearch: toggleSearch,
                    onTrace:
                      fallbackStart !== undefined || choices.length > 0 ? toggleTrace : undefined,
                    notesOpen,
                    onNotesToggle: setNotesOpen,
                  }
                : undefined
            }
            changes={
              overlay && (
                <ChangesSection
                  index={index}
                  changes={overlay.changes}
                  within={panelNode.id}
                  foldedInto={overlay.foldedInto}
                  onSelect={pickChange}
                  limit={compareDiff && movesNote(compareDiff)}
                />
              )
            }
          />
        )}
      </div>
      {pickerState && (
        <TracePicker
          choices={choices}
          suggested={suggested}
          hidden={filtered}
          state={pickerState}
          onPick={pickTrace}
          onClose={closePicker}
        />
      )}
      {searchState && (
        <SearchPalette
          entries={entries}
          hidden={filtered}
          state={searchState}
          onPick={pickSearch}
          onClose={closeSearch}
        />
      )}
      <div className="gi-visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** The filters chip: how many are on, then how many nodes they hide (or connections, when no node). */
export function filtersText(count: number, nodes: number, lines: number): string {
  const n = (x: number, one: string, many: string) =>
    `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;
  const off =
    nodes > 0 ? n(nodes, "hidden", "hidden") : n(lines, "connection hidden", "connections hidden");
  return `${n(count, "filter", "filters")} · ${off}`;
}

/** A compared commit in the diff chip: the name given, else its short SHA. */
function compareName(name: string | undefined, graph: ArchitectureGraph): ReactNode {
  return name ?? <code>{graph.repo.sha ? shortSha(graph.repo.sha) : graph.repo.name}</code>;
}

/** A trace's start in the status chip: a page's path, a route's method and path (GET and POST share one). */
function traceName(node: GraphNode): string {
  const label = nodeLabel(node);
  const name = label.code ?? label.text ?? node.label;
  return label.method ? `${label.method} ${name}` : name;
}

/** Ctrl+K or ⌘K, the palette's shortcut (with no other modifier). */
function isSearchKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

/** A field that takes typed text, where + − 0 are characters, not zoom keys. */
function isTextEntry(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"))
  );
}

/**
 * Whether an element's focus came from the keyboard (`:focus-visible`), not a
 * click. Where the selector isn't supported, it counts as the keyboard's.
 */
function keyboardFocus(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** A node's box on the canvas (not one folding away), the element that takes focus. */
function boxElement(root: HTMLElement | null, id: string): HTMLElement | null {
  const wrapper = [
    ...(root?.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])") ?? []),
  ].find((el) => el.dataset.nodeId === id);
  return wrapper?.querySelector<HTMLElement>(":scope > .gi-node") ?? null;
}

/**
 * The box a node is drawn as: itself or the nearest visible node holding it.
 * A node the filters hide has none; it isn't drawn as its parent either.
 */
function drawnAs(
  index: HierarchyIndex,
  view: GraphView,
  filtered: ReadonlySet<string>,
  id: string,
): string | undefined {
  return filtered.has(id) ? undefined : visibleAncestor(index, view, id);
}

/** The boxes holding each of `ids` in a view (the root and filtered nodes hold nothing drawn). */
function holders(
  index: HierarchyIndex,
  view: GraphView,
  filtered: ReadonlySet<string>,
  ids: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const box = drawnAs(index, view, filtered, id);
    if (box) out.add(box);
  }
  return out;
}
