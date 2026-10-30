import type { ArchitectureGraph } from "@gitinside/schema";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, StatusChip } from "../chrome/controls.js";
import type { RepoRef } from "../chrome/describe.js";
import { Breadcrumbs, Legend, Minimap, ZoomControls } from "../chrome/overlays.js";
import { TopBar } from "../chrome/TopBar.js";
import {
  createLayoutCache,
  createLayoutEngine,
  type LayoutEngine,
  type LayoutWorkerFactory,
} from "../layout/engine.js";
import {
  buildHierarchy,
  isWithin,
  layerOf,
  nodeOf,
  type HierarchyIndex,
} from "../model/hierarchy.js";
import {
  viewTrail,
  visibleAncestor,
  type GraphView,
  type ViewEdge,
  type ViewNode,
} from "../model/view.js";
import { usePresence } from "../motion.js";
import { nodeAccessibleName, nodeLabel } from "../nodes/describe.js";
import { DrillCanvas, type BoxLook, type LineLook } from "./DrillCanvas.js";
import { useDrill, type Expansion } from "./drill.js";
import { fitScale } from "./fit.js";
import { NodePanel, TracePanel } from "./panels.js";
import { checkTrace, traceNodes, type TraceScript, type TraceStep } from "./trace.js";
import type { Shown } from "./transition.js";

/** Props for {@link Explorer}. */
export interface ExplorerProps {
  graph: ArchitectureGraph;
  /** File text by repo-relative path, for code previews. Missing files show no preview. */
  sources?: Readonly<Record<string, string>> | undefined;
  /** The scripted request path the Trace button plays (until M4b.6). Without one, Trace is disabled. */
  trace?: TraceScript | undefined;
  /** Start with these nodes broken down, in opening order (the last one is closed first by Esc). */
  initialOpen?: Expansion;
  /** Start with this node selected. */
  initialSelected?: string | null;
  /** Start tracing, at this step (0-based). */
  initialStep?: number | null;
  /**
   * Draw the explorer's own top bar (default). The website turns it off and shows its own
   * repo bar: the top bar's search, filters, and share do nothing until later M4b tasks.
   */
  topBar?: boolean;
  /** Makes the layout worker (see `LayoutWorkerFactory`). Without one, layouts run on the main thread. */
  layoutWorker?: LayoutWorkerFactory | undefined;
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
 * connection in the inspector drills to its node. The Trace button or T
 * plays a scripted request path (M4b.6 brings the search) on whatever boxes
 * hold its hops at the current depth.
 *
 * Layouts come from ELK, in the host's Web Worker when given one. Until pan
 * and zoom (M4b.4), each level is fitted to the canvas.
 */
export function Explorer({
  graph,
  sources,
  trace,
  initialOpen = [],
  initialSelected = null,
  initialStep = null,
  topBar = true,
  layoutWorker,
}: ExplorerProps) {
  const index = useMemo(() => buildHierarchy(graph), [graph]);
  const engine = useMemo(() => createLayoutEngine({ worker: layoutWorker }), [layoutWorker]);
  useEffect(() => () => engine.dispose(), [engine]);
  const cache = useMemo(() => createLayoutCache(index, engine), [index, engine]);
  const drill = useDrill(index, initialOpen);
  const view = drill.view;

  const steps = useMemo(() => (trace ? checkTrace(index, trace) : []), [index, trace]);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [step, setStep] = useState<number | null>(initialStep);
  const [legend, setLegend] = useState(false);
  const legendState = usePresence(legend);
  const [announcement, setAnnouncement] = useState("");
  const [shown, setShown] = useState<Shown>();
  const [runsIn, setRunsIn] = useState<LayoutEngine["runsIn"]>();

  // Fit the drawn level to the canvas (there is no pan or zoom until M4b.4).
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCanvas({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const size = shown?.layout ?? { width: 0, height: 0 };
  const scale = fitScale(size, canvas);

  const tracing = step !== null && trace !== undefined;
  const current: TraceStep | undefined = tracing ? steps[step] : undefined;
  /** The boxes holding each node on the path, at the current depth. */
  const pathBoxes = useMemo(
    () => holders(index, view, tracing && trace ? traceNodes(steps, trace.start) : []),
    [tracing, trace, steps, index, view],
  );
  const hopIds = useMemo(() => new Set(steps.map((s) => s.edge.id)), [steps]);
  /** The current hop's two ends as drawn: the boxes holding them (one box for a hop inside it). */
  const hopBoxes = useMemo(
    () => holders(index, view, current ? [current.from.id, current.to.id] : []),
    [current, index, view],
  );

  // Starting, stepping, or ending a trace can remove the focused control (the
  // step player's buttons, "Trace from here", a disabled "Next step"), which
  // drops focus to the page and makes T and Esc stop working. Put it back: on
  // the current step while tracing, else on the box the trace started from.
  const rootRef = useRef<HTMLDivElement>(null);
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
    const start = trace ? visibleAncestor(index, view, trace.start) : undefined;
    const wrapper = [
      ...root.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])"),
    ].find((el) => el.dataset.nodeId === start);
    wrapper?.querySelector<HTMLElement>(":scope > .gi-node")?.focus();
  }, [tracing, step, trace, index, view]);

  const selectedNode = selected ? index.byId.get(selected) : undefined;
  const selectedBox = selected ? visibleAncestor(index, view, selected) : undefined;
  const repo: RepoRef = graph.repo;

  function select(id: string | null) {
    setSelected(id);
    if (id) setAnnouncement(nodeAccessibleName(nodeOf(index, id), { selected: true }));
  }

  function breakDown(id: string) {
    const n = view.byId.get(id);
    if (!n?.canOpen || n.open) return;
    drill.open(id);
    setAnnouncement(`Broke down ${n.node.label}`);
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

  function toggleTrace() {
    if (!trace) return;
    setStep(tracing ? null : 0);
    setAnnouncement(tracing ? "Trace ended" : `Tracing from ${nodeOf(index, trace.start).label}`);
  }

  /** Closes the legend; focus inside it goes back to the button that opened it. */
  function closeLegend() {
    const root = rootRef.current;
    const toggle = root?.querySelector<HTMLElement>(".gi-explorer__map .gi-overlay button");
    if (root?.querySelector(".gi-legend")?.contains(document.activeElement)) toggle?.focus();
    setLegend(false);
  }

  /**
   * Esc: close the legend → exit trace → go up a level → clear selection
   * (UX.md keyboard table). T toggles trace.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      if (legend) closeLegend();
      else if (tracing) toggleTrace();
      else if (goUp()) {
        // went up a level
      } else if (selected) select(null);
      else return;
      event.preventDefault();
    } else if (event.key === "t" || event.key === "T") {
      toggleTrace();
      event.preventDefault();
    }
  }

  /** A connection in the inspector: drill until its node is a box, and select it (UX.md). */
  function reveal(id: string) {
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
  const lineLook = (e: ViewEdge): LineLook => ({
    selected: !tracing && (selectedBox === e.from || selectedBox === e.to),
    emphasis: !tracing
      ? undefined
      : current && e.edges.some((g) => g.id === current.edge.id)
        ? "current"
        : onPath(e)
          ? "traced"
          : "dimmed",
    flow: onPath(e),
  });

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

  return (
    <div
      ref={rootRef}
      className="gi-explorer"
      data-bare={topBar ? undefined : ""}
      data-layout-runs-in={runsIn}
      onKeyDown={onKeyDown}
    >
      {topBar && <TopBar repo={repo} tracing={tracing} onTrace={trace ? toggleTrace : undefined} />}
      <div className="gi-explorer__main">
        <div
          ref={canvasRef}
          className="gi-explorer__canvas"
          role="region"
          aria-label="Diagram"
          onClick={() => select(null)}
        >
          <div className="gi-explorer__scroll">
            <div
              className="gi-explorer__fit"
              style={{ width: size.width * scale, height: size.height * scale }}
            >
              <DrillCanvas
                className="gi-explorer__drill"
                style={{ transform: `scale(${scale})` }}
                index={index}
                view={view}
                cache={cache}
                onOpen={breakDown}
                onSelect={select}
                boxLook={boxLook}
                lineLook={lineLook}
                onLayout={(next) => {
                  setShown(next);
                  setRunsIn(engine.runsIn);
                }}
              />
            </div>
          </div>
          <div className="gi-explorer__pin" data-place="top-left">
            {tracing && trace && (
              <StatusChip tone="trace" exitLabel="Exit trace" onExit={toggleTrace}>
                Tracing{" "}
                <code>
                  {nodeLabel(nodeOf(index, trace.start)).code ?? nodeOf(index, trace.start).label}
                </code>
              </StatusChip>
            )}
          </div>
          <div className="gi-explorer__pin" data-place="top-right">
            <ZoomControls zoom={scale} />
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
                viewport={{ x: 0, y: 0, width: size.width, height: size.height }}
              />
            </div>
          </div>
        </div>
        {tracing && trace ? (
          <TracePanel
            index={index}
            steps={steps}
            step={step}
            view={view}
            sources={sources}
            repo={repo}
            onStep={setStep}
            onBreakDown={breakDown}
          />
        ) : (
          <NodePanel
            index={index}
            node={selectedNode ?? index.root}
            canBreakDown={selectedView !== undefined && selectedView.canOpen && !selectedView.open}
            canTrace={trace !== undefined && selectedNode?.id === trace.start}
            hasTrace={trace !== undefined}
            sources={sources}
            repo={repo}
            onSelect={reveal}
            onBreakDown={breakDown}
            onTrace={toggleTrace}
          />
        )}
      </div>
      <div className="gi-visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** The boxes holding each of `ids` in a view (the root holds nothing drawn). */
function holders(index: HierarchyIndex, view: GraphView, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const box = visibleAncestor(index, view, id);
    if (box) out.add(box);
  }
  return out;
}
