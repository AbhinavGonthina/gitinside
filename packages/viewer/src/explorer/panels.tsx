import type { GraphNode } from "@gitinside/schema";
import { Button, Kbd, LinkButton } from "../chrome/controls.js";
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
import { REASON_TEXT } from "../nodes/describe.js";
import { useSourceText, type SourceAccess } from "./sources.js";
import { summaryOf } from "./summary.js";
import type { TraceStep } from "./trace.js";

/**
 * The explorer's inspector content (M4b.5a): a node's summary, facts,
 * connections, code, and Open on GitHub, or the trace player's current step.
 * Every word is templated from the graph (`summary.tsx`); code is loaded
 * when a selection needs it (`sources.ts`).
 */

/** How many lines the code preview shows (UX.md: 15), with the site 4 lines down. */
const PREVIEW_LINES = 15;
const PREVIEW_LEAD = 4;

/** The 15 lines of `text` around `line`, the first one's number, and the line to mark. */
export function previewLines(text: string, line: number) {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, Math.min(line - PREVIEW_LEAD, all.length - PREVIEW_LINES + 1));
  return {
    startLine: start,
    lines: all.slice(start - 1, start - 1 + PREVIEW_LINES),
    highlight: line,
  };
}

/**
 * The code section for a source location: the preview once the file is
 * here, its loading or couldn't-load frame before that (the GitHub link
 * works in all three), and nothing when there's no way to get the file.
 */
function CodeSection({
  access,
  repo,
  site,
}: {
  access: SourceAccess;
  repo: RepoRef;
  site: { file: string; line: number } | undefined;
}) {
  const source = useSourceText(access, site?.file);
  if (!site || source.status === "none") return null;
  const href = githubLineUrl(repo, site.file, site.line);
  return (
    <InspectorSection title="Code">
      {source.status === "ready" ? (
        <CodePreview path={site.file} href={href} {...previewLines(source.text, site.line)} />
      ) : (
        <CodePreview
          path={site.file}
          href={href}
          startLine={site.line}
          lines={[]}
          highlight={site.line}
          status={source.status}
        />
      )}
    </InspectorSection>
  );
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
  sources: SourceAccess;
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
  const github = source ? githubLineUrl(repo, source.file, source.line) : undefined;
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
          <CodeSection access={sources} repo={repo} site={source} />
        </>
      )}
      {(canBreakDown || canTrace || github) && (
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
          {github && (
            <LinkButton
              href={github}
              target="_blank"
              rel="noreferrer noopener"
              variant={canBreakDown || canTrace ? "quiet" : "secondary"}
              size="sm"
              trailingIcon="open-external"
            >
              Open on GitHub
            </LinkButton>
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
  sources: SourceAccess;
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
      <CodeSection key={`code-${step}`} access={sources} repo={repo} site={site} />
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
