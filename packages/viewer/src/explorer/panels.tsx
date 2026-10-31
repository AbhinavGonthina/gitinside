import type { AnalysisWarning, GraphNode } from "@gitinside/schema";
import { useId } from "react";
import { Button, Kbd, LinkButton } from "../chrome/controls.js";
import { githubLineUrl, type RepoRef } from "../chrome/describe.js";
import { WarningList } from "../chrome/EmptyState.js";
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
import { CONTEXT_LINES } from "../chrome/syntax.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { brandForFramework } from "../icons/brands.js";
import { frameCounts } from "../layout/size.js";
import { connectionsOf, type NodeConnection } from "../model/connections.js";
import { canOpen, layerOf, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import { visibleAncestor, type GraphView } from "../model/view.js";
import { nodeLabel, REASON_TEXT } from "../nodes/describe.js";
import { useSourceText, type SourceAccess } from "./sources.js";
import { summaryOf } from "./summary.js";
import { TRACE_DEPTH, type TraceStep } from "./trace.js";

/**
 * The explorer's inspector content (M4b.5a): a node's summary, facts,
 * connections, code, and Open on GitHub, or the trace player's current step.
 * Every word is templated from the graph (`summary.tsx`); code is loaded
 * when a selection needs it (`sources.ts`).
 */

/** How many lines the code preview shows (UX.md: 15), with the site 4 lines down. */
const PREVIEW_LINES = 15;
const PREVIEW_LEAD = 4;

/**
 * The 15 lines of `text` around `line`, the first one's number, the line to
 * mark, and the lines above them that the highlighter reads for context.
 */
export function previewLines(text: string, line: number) {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, Math.min(line - PREVIEW_LEAD, all.length - PREVIEW_LINES + 1));
  return {
    startLine: start,
    lines: all.slice(start - 1, start - 1 + PREVIEW_LINES),
    before: all.slice(Math.max(0, start - 1 - CONTEXT_LINES), start - 1),
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
    case "module":
    case "file":
      facts.push({ label: "Path", value: node.path, code: true });
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
  /** Whether the node is a page or route with a request path (**Trace from here**). */
  canTrace: boolean;
  /** What T traces when nothing traceable is selected, for the overview's hint. */
  traceHint: GraphNode | undefined;
  /** Whether T's picker has any page or route to offer, for the overview's hint. */
  canPick: boolean;
  sources: SourceAccess;
  repo: RepoRef;
  onSelect: (id: string) => void;
  onBreakDown: (id: string) => void;
  onTrace: (id: string) => void;
  /** The filters hide the node, so the canvas doesn't draw it. */
  filteredOut?: boolean | undefined;
  /** Takes off the filters hiding the node (**Show on canvas**). */
  onShow?: ((id: string) => void) | undefined;
  /** The analysis's warnings, listed in the repo overview (M4b.12b). */
  warnings?: readonly AnalysisWarning[] | undefined;
}

/** The overview's warnings section, which the canvas's warnings chip moves focus to. */
export const WARNINGS_SECTION = "warnings";

/** The inspector for a selected node, or the repo overview (with the analysis's warnings) for the root. */
export function NodePanel({
  index,
  node,
  canBreakDown,
  canTrace,
  traceHint,
  canPick,
  sources,
  repo,
  onSelect,
  onBreakDown,
  onTrace,
  filteredOut = false,
  onShow,
  warnings = [],
}: NodePanelProps) {
  const { incoming, outgoing } = connectionsOf(index, node.id);
  const source = "source" in node ? node.source : undefined;
  const github = source ? githubLineUrl(repo, source.file, source.line) : undefined;
  const facts = factsOf(index, node);
  const isRoot = node.id === index.root.id;
  const warningsId = useId();
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
      {filteredOut && (
        <InspectorSection title="Hidden by filters">
          <p className="gi-inspector__empty">
            The filters leave this off the canvas, with its connections.
          </p>
        </InspectorSection>
      )}
      {isRoot ? (
        <InspectorSection title="Start here">
          <p className="gi-inspector__empty">
            Select a box to see what it does. Double-click a service to break it down
            {traceHint ? (
              <>
                , or press <Kbd keys={["T"]} /> to trace the request from{" "}
                <code>{nodeLabel(traceHint).code ?? traceHint.label}</code>.
              </>
            ) : canPick ? (
              <>
                , or press <Kbd keys={["T"]} /> to pick a page or route and trace its request path.
              </>
            ) : (
              ". No page or route in this repo has a request path to trace."
            )}
          </p>
        </InspectorSection>
      ) : null}
      {isRoot && warnings.length > 0 && (
        // Focusable from the chip, so a screen reader lands on its heading.
        <section
          className="gi-inspector__section"
          data-section={WARNINGS_SECTION}
          tabIndex={-1}
          aria-labelledby={warningsId}
        >
          <h3 id={warningsId}>
            Warnings
            <span className="gi-count">{warnings.length.toLocaleString("en-US")}</span>
          </h3>
          <p className="gi-inspector__empty">
            What the analysis skipped or couldn&apos;t read, and why. The diagram leaves these out
            rather than guess.
          </p>
          <WarningList warnings={warnings} />
        </section>
      )}
      {isRoot ? null : (
        <>
          {facts.length > 0 && (
            <InspectorSection title="Facts">
              <FactList facts={facts} />
            </InspectorSection>
          )}
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
      {(canBreakDown || canTrace || github || (filteredOut && onShow)) && (
        <InspectorActions>
          {filteredOut && onShow && (
            <Button variant="primary" size="sm" onClick={() => onShow(node.id)}>
              Show on canvas
            </Button>
          )}
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
              variant={canBreakDown || (filteredOut && onShow) ? "secondary" : "primary"}
              size="sm"
              icon="trace"
              onClick={() => onTrace(node.id)}
            >
              Trace from here
            </Button>
          )}
          {github && (
            <LinkButton
              href={github}
              target="_blank"
              rel="noreferrer noopener"
              variant={canBreakDown || canTrace || (filteredOut && onShow) ? "quiet" : "secondary"}
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

/** A detail as a sentence: capitalized, with a full stop. */
function sentence(text: string): string {
  const s = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** "a, b, and 3 more": the first names of the nodes a path stops at. */
function cutOffNames(nodes: readonly GraphNode[]): string {
  const shown = nodes.slice(0, 2).map((n) => n.label);
  const rest = nodes.length - shown.length;
  if (rest > 0) return `${shown.join(", ")}, and ${rest} more`;
  return shown.join(" and ");
}

/** Props for {@link TracePanel}. */
export interface TracePanelProps {
  index: HierarchyIndex;
  steps: readonly TraceStep[];
  /** Nodes where the path stops at its depth limit though it goes on (`Trace.cutOff`). */
  cutOff: readonly GraphNode[];
  step: number;
  /** The view on the canvas, to say where the hop is drawn. */
  view: GraphView;
  sources: SourceAccess;
  repo: RepoRef;
  /** The player is advancing the steps by itself. */
  playing: boolean;
  onStep: (step: number) => void;
  /** Play or pause; play on the last step starts over. */
  onPlay: () => void;
  onBreakDown: (id: string) => void;
  /** Nodes the filters hide: a step with an end among them says so. */
  filtered?: ReadonlySet<string> | undefined;
  /** Takes off the filters hiding a node (**Show** on such a step). */
  onShow?: ((id: string) => void) | undefined;
}

/**
 * The trace player: the current step's title, match, and code, the steps
 * list, and the controls (previous / play-pause / next, UX.md).
 */
export function TracePanel({
  index,
  steps,
  cutOff,
  step,
  view,
  sources,
  repo,
  playing,
  onStep,
  onPlay,
  onBreakDown,
  filtered,
  onShow,
}: TracePanelProps) {
  const current = steps[step];
  if (!current) return null;
  const site = current.site;
  // An end the filters hide has no box: it isn't drawn as its parent either.
  const offCanvas = [current.from, current.to].find((n) => filtered?.has(n.id));
  const drawnAs = (id: string) =>
    filtered?.has(id) ? undefined : visibleAncestor(index, view, id);
  const from = drawnAs(current.from.id);
  const to = drawnAs(current.to.id);
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
      <header key={`header-${step}`} className="gi-inspector__header gi-explorer__hop-header">
        <div className="gi-inspector__chips">
          <span className="gi-chip">Request path</span>
          <span className="gi-chip">
            Step {step + 1} of {steps.length}
          </span>
        </div>
        <div className="gi-inspector__title">
          <h2 className="gi-explorer__hop">{current.title}</h2>
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
        {current.to.kind === "unresolved" && current.to.detail
          ? ` ${sentence(current.to.detail)}`
          : ""}
        {inside && hidden ? ` Happens inside ${inside.label}; break it down to watch it.` : ""}
        {offCanvas ? ` ${offCanvas.label} is hidden by filters.` : ""}
        {from && to && from !== to
          ? ` Goes from ${nodeOf(index, from).label} to ${nodeOf(index, to).label} on the canvas.`
          : ""}
      </InspectorSummary>
      {offCanvas && onShow && (
        // Beside the note it answers; the player's row below is full.
        <div key={`show-${step}`} className="gi-explorer__show">
          <Button variant="secondary" size="sm" onClick={() => onShow(offCanvas.id)}>
            Show {offCanvas.label}
          </Button>
        </div>
      )}
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
        {cutOff.length > 0 && (
          <p className="gi-inspector__empty">
            The path goes on past {TRACE_DEPTH} hops, from {cutOffNames(cutOff)}. Trace from further
            in to follow it.
          </p>
        )}
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
        {steps.length > 1 && (
          <Button
            variant="secondary"
            size="sm"
            icon={playing ? "pause" : "play"}
            // Pause, Play, and Replay take one width, so Next step holds still.
            className="gi-explorer__play"
            onClick={onPlay}
          >
            {playing ? "Pause" : step === steps.length - 1 ? "Replay" : "Play"}
          </Button>
        )}
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
