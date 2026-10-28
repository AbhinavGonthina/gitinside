import type { ArchitectureGraph, GraphNode } from "@gitinside/schema";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, Kbd, StatusChip } from "../chrome/controls.js";
import { githubLineUrl, type RepoRef } from "../chrome/describe.js";
import {
  CodePreview,
  ConnectionList,
  FactList,
  Inspector,
  InspectorActions,
  InspectorHeader,
  InspectorSection,
  InspectorSummary,
  type Fact,
} from "../chrome/Inspector.js";
import { Breadcrumbs, Legend, Minimap, ZoomControls } from "../chrome/overlays.js";
import { TopBar } from "../chrome/TopBar.js";
import { DiagramEdge, EdgeLabel } from "../edges/DiagramEdge.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { brandForFramework } from "../icons/brands.js";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { kindName, nodeAccessibleName, nodeLabel, REASON_TEXT } from "../nodes/describe.js";
import { fitScale, layout } from "./layout.js";
import {
  ancestry,
  canOpen,
  connectionsOf,
  descendants,
  drawnEdge,
  frameCounts,
  indexGraph,
  layerOf,
  liftEdges,
  nodeOf,
  visibleAncestor,
  visibleIds,
  type GraphIndex,
  type ViewEdge,
} from "./model.js";
import { checkTrace, traceNodes, type TraceScript, type TraceStep } from "./trace.js";

/** Props for {@link ExplorerPrototype}. */
export interface ExplorerPrototypeProps {
  graph: ArchitectureGraph;
  /** File text by repo-relative path, for code previews. Missing files show no preview. */
  sources?: Readonly<Record<string, string>> | undefined;
  /** The scripted request path the Trace button plays. Without one, Trace is disabled. */
  trace?: TraceScript | undefined;
  /** Start with this top-level node broken down. */
  initialOpen?: string | null;
  /** Start with this node selected. */
  initialSelected?: string | null;
  /** Start tracing, at this step (0-based). */
  initialStep?: number | null;
}

/** How many lines the code preview shows (UX.md: 15), with the site 4 lines down. */
const PREVIEW_LINES = 15;
const PREVIEW_LEAD = 4;

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** A list in words: "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** The 15 lines around `line` of `path`, or undefined when the file isn't available. */
function preview(
  sources: Readonly<Record<string, string>> | undefined,
  repo: RepoRef,
  path: string,
  line: number,
) {
  const text = sources?.[path];
  if (text === undefined) return undefined;
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, Math.min(line - PREVIEW_LEAD, all.length - PREVIEW_LINES + 1));
  return {
    path,
    startLine: start,
    lines: all.slice(start - 1, start - 1 + PREVIEW_LINES),
    highlight: line,
    href: githubLineUrl(repo, path, line),
  };
}

/** The "From the code" sentence, templated from graph facts only (no AI in v1). */
function summaryOf(index: GraphIndex, node: GraphNode): ReactNode {
  const { incoming, outgoing } = connectionsOf(index, node.id);
  switch (node.kind) {
    case "system": {
      const top = index.children.get(node.id) ?? [];
      const count = (kind: GraphNode["kind"], noun: string) =>
        plural(top.filter((n) => n.kind === kind).length, noun);
      const inside = frameCounts(index, node.id).map((c) => plural(c.value, c.noun));
      return `${count("service", "service")}, ${count("datastore", "datastore")} and ${count("external", "outside API")}, with ${listText(inside)} inside.`;
    }
    case "service": {
      const framework = node.framework
        ? (brandForFramework(node.framework)?.title ?? node.framework)
        : undefined;
      const inside = frameCounts(index, node.id).map((c) => plural(c.value, c.noun));
      return (
        <>
          {framework ? `${framework} service` : "Service"}
          {node.root ? (
            <>
              {" in "}
              <code>{node.root}</code>
            </>
          ) : null}
          {inside.length > 0 ? ` with ${listText(inside)}` : ""}. It has{" "}
          {plural(outgoing.length, "connection")} out and {incoming.length} in.
        </>
      );
    }
    case "unresolved":
      return `${node.detail ?? REASON_TEXT[node.reason]}, so it can't be linked. It's shown, not dropped.`;
    case "route":
      return (
        <>
          Handles <code>{node.label}</code>. Reached by {plural(incoming.length, "request")}; it has{" "}
          {plural(outgoing.length, "connection")} out.
        </>
      );
    default:
      return `${kindName(node)} with ${plural(outgoing.length, "connection")} out and ${incoming.length} in.`;
  }
}

/** Facts from the node's own fields. */
function factsOf(index: GraphIndex, node: GraphNode): Fact[] {
  const facts: Fact[] = [];
  switch (node.kind) {
    case "service":
      if (node.framework) {
        facts.push({
          label: "Framework",
          value: brandForFramework(node.framework)?.title ?? node.framework,
        });
      }
      facts.push({ label: "Root", value: node.root || "(repo root)", code: Boolean(node.root) });
      break;
    case "model":
      facts.push({ label: "Fields", value: node.fields.map((f) => f.name).join(", ") });
      break;
    case "datastore":
    case "queue":
      facts.push({ label: "Engine", value: node.engine });
      break;
    case "external":
      facts.push({ label: "Host", value: node.host, code: true });
      break;
    case "unresolved":
      facts.push({ label: "Reason", value: REASON_TEXT[node.reason] });
      if (node.expression) facts.push({ label: "Expression", value: node.expression, code: true });
      break;
    case "route":
      facts.push(
        { label: "Method", value: node.method },
        { label: "Path", value: node.path, code: true },
      );
      break;
    default:
      break;
  }
  for (const c of frameCounts(index, node.id)) {
    facts.push({
      label: `${c.noun.charAt(0).toUpperCase()}${c.noun.slice(1)}s`,
      value: String(c.value),
    });
  }
  if ("source" in node && node.source) {
    facts.push({ label: "File", value: `${node.source.file}:${node.source.line}`, code: true });
  }
  return facts;
}

/** Where a node lives, for the inspector header. */
function locationOf(node: GraphNode): string | undefined {
  if ("source" in node && node.source) return `${node.source.file}:${node.source.line}`;
  return undefined;
}

/** The repo's top-level node holding `id` (a child of the root), if any. */
function topLevelOf(index: GraphIndex, id: string): string | undefined {
  const chain = ancestry(index, id);
  return chain.at(-2)?.id;
}

/**
 * A static, clickable prototype of the explorer (ROADMAP M4a.7) on a real
 * analyzer graph: the top bar, a canvas with the system's services, data,
 * and outside APIs, overlays, and the inspector. It drills one level (double-
 * click, Enter, or **Break down**; Esc or the breadcrumb goes back up),
 * selects (click, Space, or a connection in the inspector), and plays a
 * scripted trace (the Trace button or T) step by step.
 *
 * It is for the design gate, not the product: the layout is a fixed column
 * layout (ELK comes in M4b.2), there is no pan or zoom, and the trace is a
 * script checked against the graph rather than M4b.6's search.
 */
export function ExplorerPrototype({
  graph,
  sources,
  trace,
  initialOpen = null,
  initialSelected = null,
  initialStep = null,
}: ExplorerPrototypeProps) {
  const index = useMemo(() => indexGraph(graph), [graph]);
  const steps = useMemo(() => (trace ? checkTrace(index, trace) : []), [index, trace]);
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [step, setStep] = useState<number | null>(initialStep);
  const [legend, setLegend] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const visible = useMemo(() => visibleIds(index, open), [index, open]);
  const viewEdges = useMemo(() => liftEdges(index, visible), [index, visible]);
  const placed = useMemo(() => layout(index, open, viewEdges), [index, open, viewEdges]);

  // Fit the diagram to the canvas (there is no pan or zoom until M4b.4).
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
  const scale = fitScale(placed, canvas);

  // Opening or closing a frame swaps its element (a closed frame is a div, an
  // open one a section), so keep keyboard focus on it: the node just opened,
  // or the one just closed.
  const lastOpen = useRef(open);
  useEffect(() => {
    if (lastOpen.current === open) return; // first render: don't take focus on load
    const target = open ?? lastOpen.current;
    lastOpen.current = open;
    const root = canvasRef.current;
    if (!target || !root || root.contains(document.activeElement)) return;
    const wrapper = [...root.querySelectorAll<HTMLElement>("[data-node-id]")].find(
      (el) => el.dataset.nodeId === target,
    );
    wrapper?.querySelector<HTMLElement>(":scope > .gi-node")?.focus();
  }, [open]);

  const tracing = step !== null && trace !== undefined;
  const current: TraceStep | undefined = tracing ? steps[step] : undefined;
  const pathNodes = useMemo(() => {
    if (!tracing || !trace) return new Set<string>();
    const out = new Set<string>();
    for (const id of traceNodes(steps, trace.start)) {
      const v = visibleAncestor(index, id, visible);
      if (v) out.add(v);
    }
    return out;
  }, [tracing, trace, steps, index, visible]);
  const hopIds = useMemo(() => new Set(steps.map((s) => s.edge.id)), [steps]);

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
      root.querySelector<HTMLElement>(".gi-proto__step[aria-current]")?.focus();
      return;
    }
    const start = trace ? visibleAncestor(index, trace.start, visible) : undefined;
    const wrapper = [...root.querySelectorAll<HTMLElement>("[data-node-id]")].find(
      (el) => el.dataset.nodeId === start,
    );
    wrapper?.querySelector<HTMLElement>(":scope > .gi-node")?.focus();
  }, [tracing, step, trace, index, visible]);

  const selectedNode = selected ? index.byId.get(selected) : undefined;
  const selectedVisible = selected ? visibleAncestor(index, selected, visible) : undefined;
  const repo: RepoRef = graph.repo;

  function select(id: string | null) {
    setSelected(id);
    if (id) setAnnouncement(nodeAccessibleName(nodeOf(index, id), { selected: true }));
  }

  function breakDown(id: string) {
    if (!canOpen(index, id) || topLevelOf(index, id) !== id) return;
    setOpen(id);
    setAnnouncement(`Broke down ${nodeOf(index, id).label}`);
  }

  function goUp() {
    if (!open) return;
    setAnnouncement(`Back to ${index.root.label}`);
    setOpen(null);
  }

  function toggleTrace() {
    if (!trace) return;
    setStep(tracing ? null : 0);
    setAnnouncement(tracing ? "Trace ended" : `Tracing from ${nodeOf(index, trace.start).label}`);
  }

  /** Closes the legend; focus inside it goes back to the button that opened it. */
  function closeLegend() {
    const root = rootRef.current;
    const toggle = root?.querySelector<HTMLElement>(".gi-proto__map .gi-overlay button");
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
      else if (open) goUp();
      else if (selected) select(null);
      else return;
      event.preventDefault();
    } else if (event.key === "t" || event.key === "T") {
      toggleTrace();
      event.preventDefault();
    }
  }

  function nodeKeyDown(event: KeyboardEvent<HTMLElement>, id: string) {
    if (event.key === "Enter") {
      if (canOpen(index, id) && topLevelOf(index, id) === id && open !== id) breakDown(id);
      else select(id);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === " ") {
      select(id);
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /** Selecting a connection selects the node itself; the canvas marks the box that holds it. */
  function reveal(id: string) {
    const top = topLevelOf(index, id);
    if (top && top !== id && canOpen(index, top) && !visible.has(id)) setOpen(top);
    select(id);
  }

  const openNode = open ? nodeOf(index, open) : undefined;
  const crumbs = [
    { id: index.root.id, label: index.root.label, kind: index.root.kind },
    ...(openNode ? [{ id: openNode.id, label: openNode.label, kind: openNode.kind }] : []),
  ];
  const topIds = (index.children.get(index.root.id) ?? []).map((n) => n.id);

  const renderNode = (id: string) => {
    const node = nodeOf(index, id);
    const box = placed.boxes.get(id);
    if (!box) return null;
    const isOpen = id === open;
    const containsPath =
      isOpen && [...pathNodes].some((p) => p !== id && ancestry(index, p).some((a) => a.id === id));
    const emphasis = !tracing
      ? undefined
      : pathNodes.has(id)
        ? ("traced" as const)
        : containsPath
          ? undefined
          : ("dimmed" as const);
    const counts = node.kind === "service" || node.kind === "module" ? frameCounts(index, id) : [];
    return (
      <div
        key={id}
        className="gi-proto__node"
        data-node-id={id}
        data-inner={topLevelOf(index, id) === id ? undefined : ""}
        data-open={isOpen ? "" : undefined}
        style={{
          transform: `translate(${box.x}px, ${box.y}px)`,
          width: box.width,
          height: box.height,
        }}
      >
        <DiagramNode
          node={node}
          layer={layerOf(index, id)}
          counts={isOpen ? [] : counts}
          expanded={isOpen}
          selected={selectedVisible === id}
          emphasis={emphasis}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            select(id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            breakDown(id);
          }}
          onKeyDown={(e) => nodeKeyDown(e, id)}
        />
      </div>
    );
  };

  /** On the request path: the line is traced and its particles flow. */
  const onPath = (view: ViewEdge) => tracing && view.edges.some((e) => hopIds.has(e.id));

  /** Selected = the current trace step's edge, or an edge of the selection when not tracing. */
  const edgeState = (view: ViewEdge) => ({
    selected: tracing
      ? Boolean(current && view.edges.some((e) => e.id === current.edge.id))
      : selectedVisible === view.from || selectedVisible === view.to,
    emphasis: !tracing ? undefined : onPath(view) ? ("traced" as const) : ("dimmed" as const),
  });

  return (
    <div ref={rootRef} className="gi-proto" onKeyDown={onKeyDown}>
      <TopBar repo={repo} tracing={tracing} onTrace={trace ? toggleTrace : undefined} />
      <div className="gi-proto__main">
        <div
          ref={canvasRef}
          className="gi-proto__canvas"
          role="region"
          aria-label="Diagram"
          onClick={() => select(null)}
        >
          <div className="gi-proto__scroll">
            <div
              className="gi-proto__fit"
              style={{ width: placed.width * scale, height: placed.height * scale }}
            >
              <div
                className="gi-proto__stage"
                style={{ width: placed.width, height: placed.height, transform: `scale(${scale})` }}
              >
                {/* One stable list, so a node keeps its element (and focus) when it opens. */}
                {/* In reading order, so Tab moves left to right and into an open frame. */}
                {placed.order.map(renderNode)}
                <svg
                  className="gi-proto__edges"
                  width={placed.width}
                  height={placed.height}
                  aria-label="Connections"
                  role="group"
                >
                  {placed.edges.map(({ view, points }) => {
                    const { edge, count } = drawnEdge(view);
                    return (
                      <DiagramEdge
                        key={view.id}
                        edge={edge}
                        count={count}
                        points={points}
                        layer={layerOf(index, view.from)}
                        ends={{
                          from: nodeOf(index, view.from).label,
                          to: nodeOf(index, view.to).label,
                        }}
                        flow={onPath(view)}
                        {...edgeState(view)}
                      />
                    );
                  })}
                </svg>
                {placed.edges.map(({ view, label }) => {
                  const { edge, count } = drawnEdge(view);
                  return (
                    <EdgeLabel
                      key={view.id}
                      edge={edge}
                      count={count}
                      layer={layerOf(index, view.from)}
                      style={{ left: label.x, top: label.y }}
                      {...edgeState(view)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <div className="gi-proto__pin" data-place="top-left">
            {tracing && trace && (
              <StatusChip tone="trace" exitLabel="Exit trace" onExit={toggleTrace}>
                Tracing{" "}
                <code>
                  {nodeLabel(nodeOf(index, trace.start)).code ?? nodeOf(index, trace.start).label}
                </code>
              </StatusChip>
            )}
          </div>
          <div className="gi-proto__pin" data-place="top-right">
            <ZoomControls zoom={scale} />
          </div>
          <div
            className="gi-proto__pin"
            data-place="bottom-left"
            onClick={(e) => e.stopPropagation()}
          >
            <Breadcrumbs items={crumbs} onSelect={(id) => id === index.root.id && goUp()} />
          </div>
          <div
            className="gi-proto__pin"
            data-place="bottom-right"
            onClick={(e) => e.stopPropagation()}
          >
            {legend && <Legend onClose={closeLegend} />}
            <div className="gi-proto__map">
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
                nodes={topIds.flatMap((id) => {
                  const rect = placed.boxes.get(id);
                  return rect ? [{ id, rect, layer: layerOf(index, id) }] : [];
                })}
                viewport={{ x: 0, y: 0, width: placed.width, height: placed.height }}
              />
            </div>
          </div>
        </div>
        {tracing && trace ? (
          <TracePanel
            index={index}
            steps={steps}
            step={step}
            visible={visible}
            sources={sources}
            repo={repo}
            onStep={setStep}
            onBreakDown={breakDown}
          />
        ) : (
          <NodePanel
            index={index}
            node={selectedNode ?? index.root}
            canBreakDown={
              selectedNode !== undefined &&
              canOpen(index, selectedNode.id) &&
              topLevelOf(index, selectedNode.id) === selectedNode.id &&
              open !== selectedNode.id
            }
            canTrace={trace !== undefined && selectedNode?.id === trace.start}
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

function NodePanel({
  index,
  node,
  canBreakDown,
  canTrace,
  sources,
  repo,
  onSelect,
  onBreakDown,
  onTrace,
}: {
  index: GraphIndex;
  node: GraphNode;
  canBreakDown: boolean;
  canTrace: boolean;
  sources: Readonly<Record<string, string>> | undefined;
  repo: RepoRef;
  onSelect: (id: string) => void;
  onBreakDown: (id: string) => void;
  onTrace: () => void;
}) {
  const { incoming, outgoing } = connectionsOf(index, node.id);
  const source = "source" in node ? node.source : undefined;
  const code = source ? preview(sources, repo, source.file, source.line) : undefined;
  const isRoot = node.id === index.root.id;
  const connection = (c: (typeof incoming)[number]) => ({
    node: c.other,
    layer: layerOf(index, c.other.id),
    edge: c.edge,
  });
  return (
    <Inspector>
      <InspectorHeader node={node} layer={layerOf(index, node.id)} location={locationOf(node)} />
      <InspectorSummary>{summaryOf(index, node)}</InspectorSummary>
      {isRoot ? (
        <InspectorSection title="Start here">
          <p className="gi-inspector__empty">
            Select a box to see what it does. Double-click a service to break it down, or press{" "}
            <Kbd keys={["T"]} /> to trace the checkout request.
          </p>
        </InspectorSection>
      ) : (
        <>
          <InspectorSection title="Facts">
            <FactList facts={factsOf(index, node)} />
          </InspectorSection>
          <InspectorSection title="Called by" count={incoming.length}>
            <ConnectionList
              items={incoming.map(connection)}
              empty="Nothing in the repo calls this."
              onSelect={onSelect}
            />
          </InspectorSection>
          <InspectorSection title="Calls" count={outgoing.length}>
            <ConnectionList
              items={outgoing.map(connection)}
              empty="This calls nothing in the repo."
              onSelect={onSelect}
            />
          </InspectorSection>
          {code && (
            <InspectorSection title="Code">
              <CodePreview {...code} />
            </InspectorSection>
          )}
        </>
      )}
      {(canBreakDown || canTrace) && (
        <InspectorActions>
          {canBreakDown && (
            <Button
              variant="primary"
              size="sm"
              icon="break-down"
              shortcut={["Enter"]}
              onClick={() => onBreakDown(node.id)}
            >
              Break down
            </Button>
          )}
          {canTrace && (
            <Button
              variant={canBreakDown ? "secondary" : "primary"}
              size="sm"
              icon="trace"
              onClick={onTrace}
            >
              Trace from here
            </Button>
          )}
        </InspectorActions>
      )}
    </Inspector>
  );
}

function TracePanel({
  index,
  steps,
  step,
  visible,
  sources,
  repo,
  onStep,
  onBreakDown,
}: {
  index: GraphIndex;
  steps: readonly TraceStep[];
  step: number;
  visible: ReadonlySet<string>;
  sources: Readonly<Record<string, string>> | undefined;
  repo: RepoRef;
  onStep: (step: number) => void;
  onBreakDown: (id: string) => void;
}) {
  const current = steps[step];
  if (!current) return null;
  const site = current.site;
  const code = site ? preview(sources, repo, site.file, site.line) : undefined;
  const from = visibleAncestor(index, current.from.id, visible);
  const to = visibleAncestor(index, current.to.id, visible);
  const inside = from !== undefined && from === to ? nodeOf(index, from) : undefined;
  const hidden = inside ? descendants(index, inside.id).length > 0 : false;
  // The prototype drills one level: only a closed top-level node can be broken down.
  const breakable = inside !== undefined && topLevelOf(index, inside.id) === inside.id;
  return (
    <Inspector>
      <header className="gi-inspector__header">
        <div className="gi-inspector__chips">
          <span className="gi-chip">Request path</span>
          <span className="gi-chip">
            Step {step + 1} of {steps.length}
          </span>
        </div>
        <div className="gi-inspector__title">
          <h2>{current.title}</h2>
        </div>
        {site && (
          <p className="gi-inspector__location">
            <code>
              {site.file}:{site.line}
            </code>
          </p>
        )}
      </header>
      <InspectorSummary>
        {CONFIDENCE_TEXT[current.edge.confidence]}
        {current.edge.reason ? ` (${REASON_TEXT[current.edge.reason]})` : ""}.
        {inside && hidden
          ? ` Happens inside ${inside.label}${breakable ? "; break it down to watch it" : ""}.`
          : ""}
        {!inside && from && to
          ? ` Goes from ${nodeOf(index, from).label} to ${nodeOf(index, to).label} on the canvas.`
          : ""}
      </InspectorSummary>
      {code && (
        <InspectorSection title="Code">
          <CodePreview {...code} />
        </InspectorSection>
      )}
      <InspectorSection title="Steps" count={steps.length}>
        <ol className="gi-proto__steps">
          {steps.map((s, i) => (
            <li key={s.edge.id}>
              <button
                type="button"
                className="gi-proto__step"
                aria-current={i === step ? "step" : undefined}
                onClick={() => onStep(i)}
              >
                <span className="gi-proto__step-number">{i + 1}</span>
                <span>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </InspectorSection>
      <InspectorActions>
        <Button
          variant="secondary"
          size="sm"
          disabled={step === 0}
          onClick={() => onStep(step - 1)}
        >
          Previous
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon="chevron-right"
          disabled={step === steps.length - 1}
          onClick={() => onStep(step + 1)}
        >
          Next step
        </Button>
        {inside && hidden && breakable && (
          <Button
            variant="quiet"
            size="sm"
            icon="break-down"
            onClick={() => onBreakDown(inside.id)}
          >
            Break down {inside.label}
          </Button>
        )}
      </InspectorActions>
    </Inspector>
  );
}
