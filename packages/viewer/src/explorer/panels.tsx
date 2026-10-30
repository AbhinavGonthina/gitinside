import type { GraphNode } from "@gitinside/schema";
import type { ReactNode } from "react";
import { Button, Kbd } from "../chrome/controls.js";
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
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { brandForFramework } from "../icons/brands.js";
import { frameCounts } from "../layout/size.js";
import { connectionsOf, type NodeConnection } from "../model/connections.js";
import { canOpen, layerOf, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import { visibleAncestor, type GraphView } from "../model/view.js";
import { kindName, REASON_TEXT } from "../nodes/describe.js";
import type { TraceStep } from "./trace.js";

/**
 * The explorer's inspector content (from the M4a.7 prototype; M4b.5 brings
 * the full inspector): a node's summary, facts, connections, and code, or the
 * trace player's current step. Every word is templated from the graph.
 */

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
function summaryOf(index: HierarchyIndex, node: GraphNode): ReactNode {
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
function factsOf(index: HierarchyIndex, node: GraphNode): Fact[] {
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

/** Props for {@link NodePanel}. */
export interface NodePanelProps {
  index: HierarchyIndex;
  node: GraphNode;
  canBreakDown: boolean;
  canTrace: boolean;
  hasTrace: boolean;
  sources: Readonly<Record<string, string>> | undefined;
  repo: RepoRef;
  onSelect: (id: string) => void;
  onBreakDown: (id: string) => void;
  onTrace: () => void;
}

/** The inspector for a selected node, or the repo overview for the root. */
export function NodePanel({
  index,
  node,
  canBreakDown,
  canTrace,
  hasTrace,
  sources,
  repo,
  onSelect,
  onBreakDown,
  onTrace,
}: NodePanelProps) {
  const { incoming, outgoing } = connectionsOf(index, node.id);
  const source = "source" in node ? node.source : undefined;
  const code = source ? preview(sources, repo, source.file, source.line) : undefined;
  const isRoot = node.id === index.root.id;
  const connection = (c: NodeConnection) => ({
    node: c.other,
    layer: layerOf(index, c.other.id),
    edge: c.edge,
  });
  return (
    // Keyed by the selection: a new node's content swaps in (chrome.css) and starts scrolled to the top.
    <Inspector key={node.id}>
      <InspectorHeader node={node} layer={layerOf(index, node.id)} location={locationOf(node)} />
      <InspectorSummary>{summaryOf(index, node)}</InspectorSummary>
      {isRoot ? (
        <InspectorSection title="Start here">
          <p className="gi-inspector__empty">
            Select a box to see what it does. Double-click a service to break it down
            {hasTrace ? (
              <>
                , or press <Kbd keys={["T"]} /> to trace the checkout request.
              </>
            ) : (
              "."
            )}
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

/** Props for {@link TracePanel}. */
export interface TracePanelProps {
  index: HierarchyIndex;
  steps: readonly TraceStep[];
  step: number;
  /** The view on the canvas, to say where the hop is drawn. */
  view: GraphView;
  sources: Readonly<Record<string, string>> | undefined;
  repo: RepoRef;
  onStep: (step: number) => void;
  onBreakDown: (id: string) => void;
}

/** The trace player: the current step's title, match, and code, the steps list, and the controls. */
export function TracePanel({
  index,
  steps,
  step,
  view,
  sources,
  repo,
  onStep,
  onBreakDown,
}: TracePanelProps) {
  const current = steps[step];
  if (!current) return null;
  const site = current.site;
  const code = site ? preview(sources, repo, site.file, site.line) : undefined;
  const from = visibleAncestor(index, view, current.from.id);
  const to = visibleAncestor(index, view, current.to.id);
  // Both ends in one closed box: the hop happens inside it, out of sight.
  const inside =
    from !== undefined && from === to && !view.byId.get(from)?.open
      ? nodeOf(index, from)
      : undefined;
  const hidden = inside !== undefined && canOpen(index, inside.id);
  // The step's header, summary, and code are keyed by the step so they swap in
  // (chrome.css); the steps list and the player's buttons stay, keeping focus.
  return (
    <Inspector>
      <header key={`header-${step}`} className="gi-inspector__header">
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
      <InspectorSummary key={`summary-${step}`}>
        {CONFIDENCE_TEXT[current.edge.confidence]}
        {current.edge.reason ? ` (${REASON_TEXT[current.edge.reason]})` : ""}.
        {inside && hidden ? ` Happens inside ${inside.label}; break it down to watch it.` : ""}
        {from && to && from !== to
          ? ` Goes from ${nodeOf(index, from).label} to ${nodeOf(index, to).label} on the canvas.`
          : ""}
      </InspectorSummary>
      {code && (
        <InspectorSection key={`code-${step}`} title="Code">
          <CodePreview {...code} />
        </InspectorSection>
      )}
      <InspectorSection title="Steps" count={steps.length}>
        <ol className="gi-explorer__steps">
          {steps.map((s, i) => (
            <li key={s.edge.id}>
              <button
                type="button"
                className="gi-explorer__step"
                aria-current={i === step ? "step" : undefined}
                onClick={() => onStep(i)}
              >
                <span className="gi-explorer__step-number">{i + 1}</span>
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
        {inside && hidden && (
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
