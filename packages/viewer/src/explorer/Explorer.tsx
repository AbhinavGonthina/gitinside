import { compareStrings } from "@gitinside/schema";
import type { ArchitectureGraph, EdgeKind, GraphNode } from "@gitinside/schema";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, StatusChip } from "../chrome/controls.js";
import type { RepoRef } from "../chrome/describe.js";
import { FiltersPopover } from "../chrome/FiltersPopover.js";
import { ShareMenu } from "../chrome/ShareMenu.js";
import { viewExport, type ViewExport } from "../export/files.js";
import { Breadcrumbs, Legend, Minimap, ZoomControls } from "../chrome/overlays.js";
import { TopBar } from "../chrome/TopBar.js";
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
  type Filters,
} from "../model/filters.js";
import {
  buildHierarchy,
  isWithin,
  layerOf,
  nodeOf,
  type HierarchyIndex,
} from "../model/hierarchy.js";
import {
  DEFAULT_HIDDEN_KINDS,
  viewTrail,
  visibleAncestor,
  type GraphView,
  type ViewEdge,
  type ViewNode,
} from "../model/view.js";
import { usePresence } from "../motion.js";
import { nodeLabel } from "../nodes/describe.js";
import { durations } from "../tokens.js";
import { selectionAnnouncement } from "./a11y.js";
import {
  centerOn,
  clampZoom,
  ensureVisible,
  fitCamera,
  holdInPlace,
  keepInView,
  sameCamera,
  stepZoom,
  visibleRect,
  zoomToBox,
  type Camera,
  type Size,
} from "./camera.js";
import { encodeState, withState, type ExplorerState } from "./deepLink.js";
import { DrillCanvas, toggledBetween, type BoxLook, type LineLook } from "./DrillCanvas.js";
import { useDrill, type Expansion } from "./drill.js";
import { useCanvasGestures, type CameraMotion } from "./gestures.js";
import { hintSteps, OnboardingHint, type HintStep, type OnboardingStore } from "./onboarding.js";
import { NodePanel, TracePanel } from "./panels.js";
import { traceChoices, TracePicker } from "./picker.js";
import { SearchPalette, searchEntries } from "./search.js";
import { useSourceAccess, type SourceLoader } from "./sources.js";
import { canTraceFrom, traceFrom, traceNodes, type TraceStep } from "./trace.js";
import type { Shown } from "./transition.js";

/** How long the player stays on a step: the pulse travels its hop three times. */
export const PLAY_STEP_MS = durations["trace-hop"] * 3;

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
}

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
 * is fitted to the canvas until the user pans (drag, wheel, or the minimap)
 * or zooms (Ctrl or ⌘ + wheel, a pinch, − / +, or the zoom buttons); from
 * then on the camera is theirs, and breaking a node down keeps that node
 * where it was on the canvas, until they fit again (0 or the fit button).
 * Text thins out as the camera zooms out (`detailAt`): subtitles, counts,
 * and edge labels first, then everything but service names and the lines
 * between services.
 */
export function Explorer({
  graph,
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
}: ExplorerProps) {
  const index = useMemo(() => buildHierarchy(graph), [graph]);
  const sourceAccess = useSourceAccess(sources, loadSource);
  const engine = useMemo(() => createLayoutEngine({ worker: layoutWorker }), [layoutWorker]);
  useEffect(() => () => engine.dispose(), [engine]);
  const cache = useMemo(() => createLayoutCache(index, engine), [index, engine]);
  // The filters (M4b.8b): nodes and confidence levels, and connection kinds (imports off).
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<EdgeKind>>(() =>
    initialHiddenKinds ? new Set(initialHiddenKinds) : DEFAULT_HIDDEN_KINDS,
  );
  /** Every node the filters leave off the canvas. */
  const filtered = useMemo(() => hiddenNodes(index, filters), [index, filters]);
  const options = useMemo(() => filterOptions(index), [index]);
  const filterCount =
    activeFilterCount(filters) +
    [...hiddenKinds].filter((k) => !DEFAULT_HIDDEN_KINDS.has(k)).length;
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
  const drill = useDrill(index, initialOpen, { filters, hiddenKinds });
  const view = drill.view;

  const [selected, setSelected] = useState<string | null>(initialSelected);
  /** `traceStart`, if it's in this graph and has somewhere to go. */
  const traceStartNode = traceStart === undefined ? undefined : index.byId.get(traceStart);
  const fallbackStart =
    traceStartNode && canTraceFrom(index, traceStartNode) ? traceStartNode.id : undefined;
  // The trace's start outlives the trace, so focus can go back to it on exit.
  const [traced, setTraced] = useState<string | null>(() => {
    const linked = initialTrace === null ? undefined : index.byId.get(initialTrace);
    if (linked && canTraceFrom(index, linked)) return linked.id;
    return fallbackStart !== undefined && initialStep !== null ? fallbackStart : null;
  });
  const [step, setStep] = useState<number | null>(traced === null ? null : (initialStep ?? 0));
  // A new graph without the traced node ends the trace rather than throwing.
  const path = useMemo(
    () => (traced && index.byId.has(traced) ? traceFrom(index, traced) : undefined),
    [index, traced],
  );
  const steps = path?.steps ?? [];
  const [playing, setPlaying] = useState(false);
  // The picker T and the Trace button open when there's nothing to trace yet.
  const choices = useMemo(() => traceChoices(index), [index]);
  const [picking, setPicking] = useState(false);
  const pickerState = usePresence(picking);
  // The Ctrl+K palette (M4b.7), over every node.
  const entries = useMemo(() => searchEntries(index), [index]);
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
  const [announcement, setAnnouncement] = useState("");
  const [shown, setShown] = useState<Shown>();
  // Export (M4b.10b): what's drawn, at the layout it was drawn at.
  const exported = useMemo(() => shown && viewExport(index, shown), [index, shown]);
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
  const camera = handSet ?? fitCamera(size, canvas);
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

  /**
   * A new layout: a fitted camera refits with it; a hand-set one moves so the
   * node just broken down or closed keeps its corner where it was, gliding
   * with the boxes.
   */
  function onLayout(next: Shown) {
    const prev = shown;
    setShown(next);
    setRunsIn(engine.runsIn);
    setCameraMotion("layout");
    if (!prev || handSet === null) return;
    const toggled = toggledBetween(prev.view, next.view)[0];
    const before = prev.layout.boxes.find((b) => b.id === toggled);
    const after = next.layout.boxes.find((b) => b.id === toggled);
    if (before && after) setHandSet((c) => c && holdInPlace(c, before, after));
  }

  // A connection picked in the inspector: once its level is drawn, fly to it
  // if it's off the canvas (UX.md "selecting flies there, drilling if needed").
  // A palette pick also zooms in until it's readable and moves focus to its
  // box, so the keys go on from there.
  const flyTo = useRef<string | null>(null);
  const fromPalette = useRef(false);
  useEffect(() => {
    const id = flyTo.current;
    if (!id || !shown || shown.view !== view) return;
    flyTo.current = null;
    const picked = fromPalette.current;
    fromPalette.current = false;
    if (picked) boxElement(rootRef.current, id)?.focus({ preventScroll: true });
    const box = shown.layout.boxes.find((b) => b.id === id);
    if (!box) return;
    const { camera: now, canvas: room } = live.current;
    const next = picked ? zoomToBox(now, box, room) : ensureVisible(now, box, room);
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
  const selectionTraces = selectedNode !== undefined && canTraceFrom(index, selectedNode);
  /** What T and the Trace button trace: the selection if it can be, else `traceStart`. */
  const startable = selectionTraces ? selectedNode.id : fallbackStart;
  const selectedBox = selected ? drawnAs(index, view, filtered, selected) : undefined;
  const repo: RepoRef = graph.repo;

  // First-visit hints (M4b.12a, UX.md "Onboarding"): chosen once from what
  // the explorer opened with, after mount, so a server render (no storage)
  // matches the first client one. Kept while the last one plays its exit.
  const [hints, setHints] = useState<{ steps: readonly HintStep[]; at: number } | null>(null);
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
    const steps = hintSteps(hintStart.current);
    if (steps.length === 0) return;
    setHints({ steps, at: 0 });
    setHintsOn(true);
  }, [onboarding]);

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

  /** The reader did what a hint says: if it's the one showing, it moves on. */
  function hintDone(step: HintStep) {
    if (hintsOn && hints?.steps[hints.at] === step) nextHint();
  }

  /** Selects a node (or none), saying what it connects to (UX.md). */
  function select(id: string | null) {
    setSelected(id);
    if (id) {
      setAnnouncement(selectionAnnouncement(index, id, hiddenKinds));
      hintDone("select");
    } else if (selected) setAnnouncement("Selection cleared");
  }

  /**
   * A box focused from the keyboard (Tab, an arrow key, focus put back after
   * a change): the camera glides to it if it isn't wholly on the canvas, once
   * the box's layout is the one drawn (focus put back after breaking down
   * comes before the explorer has the new layout). A click's focus leaves
   * the camera alone, so a box half off the edge doesn't jump away from the
   * pointer.
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
   */
  function showNode(id: string) {
    if (!filtered.has(id)) return;
    refocus.current = true;
    setFilters(filtersShowing(index, filters, id));
    setAnnouncement(`Changed the filters to show ${nodeOf(index, id).label}`);
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
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    const root = rootRef.current;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!root || !lost) {
      refocus.current = false;
      return;
    }
    if (tracing) {
      const current = root.querySelector<HTMLElement>(".gi-explorer__step[aria-current]");
      if (current) {
        refocus.current = false;
        current.focus();
      }
      return;
    }
    // Wait for the new view's boxes: the old layout's may be replaced.
    if (shown?.view !== view) return;
    refocus.current = false;
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
    showNode(id);
    setTraced(id);
    setStep(0);
    setPlaying(false);
    setAnnouncement(`Tracing from ${nodeOf(index, id).label}`);
    hintDone("trace");
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
    fromPalette.current = true;
    reveal(id);
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
    const toggle = root?.querySelector<HTMLElement>(".gi-explorer__map .gi-overlay button");
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
   * hide it, drill until it's a box, and select it (UX.md).
   */
  function reveal(id: string) {
    showNode(id);
    flyTo.current = id;
    drill.reveal(id);
    select(id);
  }

  /**
   * While tracing: the current hop's boxes are `current`, the rest of the
   * path `traced`, an open frame holding part of it plain, everything else
   * dimmed. The selection is drawn either way.
   */
  const boxLook = (n: ViewNode): BoxLook => ({
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
   * `traced`, everything else dimmed. Otherwise the selection's lines are selected.
   */
  const lineLook = (e: ViewEdge): LineLook => {
    const isHop = current !== undefined && e.edges.some((g) => g.id === current.edge.id);
    return {
      selected: !tracing && (selectedBox === e.from || selectedBox === e.to),
      emphasis: !tracing ? undefined : isHop ? "current" : onPath(e) ? "traced" : "dimmed",
      flow: onPath(e),
      // The pulse runs the way the request goes, against the line for a queue's consumer.
      pulse: !isHop ? undefined : e.to === hopStart && e.from !== hopStart ? "backward" : "forward",
    };
  };

  const trailEnd = deepestOpen(view, drill.expansion);
  const crumbs = [
    { id: index.root.id, label: index.root.label, kind: index.root.kind },
    ...(trailEnd ? viewTrail(view, trailEnd) : []).map((n) => ({
      id: n.id,
      label: n.node.label,
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
  const hint = hints?.steps[hints.at];

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

  return (
    <div
      ref={rootRef}
      className="gi-explorer"
      data-bare={topBar ? undefined : ""}
      data-layout-runs-in={runsIn}
      data-settled={settled ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {topBar && (
        <TopBar
          repo={repo}
          mac={mac}
          onSearch={toggleSearch}
          filterCount={filterCount}
          filtersOpen={filtering}
          onFilters={() => toggleFilters("top")}
          share={<ShareMenu link={() => linkTo(linkKey)} exports={() => exported} />}
          tracing={tracing}
          onTrace={toggleTrace}
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
          />
          <div
            className="gi-explorer__pin"
            data-place="top-left"
            onClick={(e) => e.stopPropagation()}
          >
            {tracing && (
              <StatusChip tone="trace" exitLabel="Exit trace" onExit={toggleTrace}>
                Tracing <code>{traceName(path.start)}</code>
              </StatusChip>
            )}
            {filtered.size > 0 || linesOff > 0 ? (
              <StatusChip exitLabel="Clear filters" onExit={clearFilters}>
                <button
                  type="button"
                  className="gi-status__open"
                  data-filters-opener=""
                  aria-expanded={filtering}
                  onClick={() => toggleFilters("canvas")}
                >
                  {filtersText(filterCount, filtered.size, linesOff)}
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
            <ZoomControls
              zoom={camera.zoom}
              onZoomIn={() => zoomBy(1)}
              onZoomOut={() => zoomBy(-1)}
              onFit={fitView}
            />
            {filtersFrom === "top" && filtersPopover()}
          </div>
          <div
            className="gi-explorer__pin"
            data-place="bottom-left"
            onClick={(e) => e.stopPropagation()}
          >
            <Breadcrumbs items={crumbs} onSelect={goTo} />
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
              <Minimap
                nodes={minimapNodes}
                viewport={
                  canvas.width > 0
                    ? visibleRect(camera, canvas)
                    : { x: 0, y: 0, width: size.width, height: size.height }
                }
                onNavigate={(p) =>
                  moveCamera(centerOn(live.current.camera, p, live.current.canvas), "none")
                }
              />
            </div>
          </div>
        </div>
        {tracing ? (
          <TracePanel
            index={index}
            steps={steps}
            cutOff={path.cutOff}
            step={step}
            view={view}
            sources={sourceAccess}
            repo={repo}
            playing={playing}
            onStep={goToStep}
            onPlay={togglePlay}
            onBreakDown={breakDown}
            filtered={filtered}
            onShow={showNode}
          />
        ) : (
          <NodePanel
            index={index}
            node={selectedNode ?? index.root}
            canBreakDown={selectedView !== undefined && selectedView.canOpen && !selectedView.open}
            canTrace={selectionTraces}
            traceHint={fallbackStart ? nodeOf(index, fallbackStart) : undefined}
            canPick={choices.length > 0}
            sources={sourceAccess}
            repo={repo}
            onSelect={reveal}
            onBreakDown={breakDown}
            onTrace={startTrace}
            filteredOut={selectedNode !== undefined && filtered.has(selectedNode.id)}
            onShow={showNode}
          />
        )}
      </div>
      {pickerState && (
        <TracePicker
          choices={choices}
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
