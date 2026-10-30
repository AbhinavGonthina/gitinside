import type { Meta, StoryObj } from "@storybook/react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { DiagramEdge, EdgeLabel } from "../edges/DiagramEdge.js";
import { edgeGeometry, type Point } from "../edges/geometry.js";
import type { EdgeLike } from "../edges/describe.js";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { nodeSubtitle } from "../nodes/describe.js";
import { sampleOf } from "../nodes/samples.js";
import { cssVar } from "../tokens.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  Button,
  IconButton,
  Kbd,
  LinkButton,
  SegmentedControl,
  StatusChip,
  Toggle,
  type ButtonVariant,
} from "./controls.js";
import { githubLineUrl } from "./describe.js";
import {
  CodePreview,
  ConnectionList,
  FactList,
  Inspector,
  InspectorActions,
  InspectorHeader,
  InspectorSection,
  InspectorSummary,
} from "./Inspector.js";
import { Breadcrumbs, Legend, Minimap, ZoomControls } from "./overlays.js";
import {
  minimapNodes,
  paletteResults,
  routeCalledBy,
  routeCalls,
  routeCode,
  routeFacts,
  sampleCrumbs,
  sampleRepo,
} from "./samples.js";
import { TopBar, type DiffView } from "./TopBar.js";
import { LogoMark, UiIcon, uiIconNames } from "./uiIcons.js";

// The explorer's chrome: controls, the top bar, canvas overlays, the legend,
// the inspector, the command palette, and all of them around a canvas, in
// whichever theme the toolbar selects.

const muted: CSSProperties = { color: cssVar("text-muted"), fontSize: cssVar("font-size-12") };

function Page({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: cssVar("space-24"),
        alignContent: "start",
        padding: cssVar("space-32"),
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontSize: cssVar("font-size-28"),
            fontWeight: cssVar("font-weight-semibold"),
            letterSpacing: "-0.02em",
            lineHeight: cssVar("line-height-tight"),
          }}
        >
          {title}
        </h1>
        <p style={{ margin: `${cssVar("space-8")} 0 0`, color: cssVar("text-muted") }}>{note}</p>
      </header>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: cssVar("space-12") }}>
      <h2 style={{ margin: 0, fontSize: cssVar("font-size-14"), color: cssVar("text-muted") }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

const VARIANTS: readonly ButtonVariant[] = ["primary", "secondary", "quiet"];

function ControlSheet() {
  const [hideTests, setHideTests] = useState(true);
  const [externals, setExternals] = useState(false);
  const [view, setView] = useState<DiffView>("overlay");
  return (
    <Page
      title="Controls"
      note="Quiet by default: one primary action per surface, bordered secondary actions, and quiet buttons in toolbars."
    >
      {VARIANTS.map((variant) => (
        <Group key={variant} title={`Button, ${variant}`}>
          <Button variant={variant} icon="trace" shortcut={["T"]}>
            Trace a request
          </Button>
          <Button variant={variant} icon="break-down">
            Break down
          </Button>
          <Button variant={variant} size="sm">
            Small
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
          <IconButton variant={variant} icon="share" label="Share" />
          <IconButton variant={variant} icon="close" label="Close" size="sm" />
        </Group>
      ))}
      <Group title="Switches">
        <Toggle checked={hideTests} onChange={setHideTests}>
          Hide tests and config
        </Toggle>
        <Toggle checked={externals} onChange={setExternals}>
          Show external APIs
        </Toggle>
      </Group>
      <Group title="Segmented control">
        <SegmentedControl
          label="Diff view"
          options={[
            { value: "base", label: "Base" },
            { value: "head", label: "Head" },
            { value: "overlay", label: "Overlay" },
          ]}
          value={view}
          onChange={setView}
        />
      </Group>
      <Group title="Keys and chips">
        <Kbd keys={["Ctrl", "K"]} />
        <Kbd keys={["Esc"]} />
        <span className="gi-chip">Route</span>
        <span className="gi-chip" data-layer="backend">
          <span className="gi-chip__dot" />
          Backend
        </span>
        <span className="gi-count">3</span>
      </Group>
      <Group title="Interface icons">
        {uiIconNames.map((name) => (
          <span
            key={name}
            title={name}
            style={{ display: "inline-flex", padding: 6, color: cssVar("text-muted") }}
          >
            <UiIcon name={name} />
          </span>
        ))}
        <span style={{ display: "inline-flex", padding: 6 }}>
          <LogoMark size={24} />
        </span>
      </Group>
      <Group title="Status chips">
        <StatusChip tone="trace" exitLabel="Exit trace">
          Tracing <code style={{ fontFamily: cssVar("font-mono") }}>/checkout</code>
        </StatusChip>
        <StatusChip tone="diff">Comparing main → PR #12</StatusChip>
        <StatusChip exitLabel="Clear filters">2 filters</StatusChip>
      </Group>
    </Page>
  );
}

function TopBarSheet() {
  const [view, setView] = useState<DiffView>("overlay");
  const row = (label: string, bar: ReactNode) => (
    <div style={{ display: "grid", gap: cssVar("space-8") }}>
      <span style={muted}>{label}</span>
      <div
        style={{ border: `1px solid ${cssVar("border")}`, borderRadius: 10, overflow: "hidden" }}
      >
        {bar}
      </div>
    </div>
  );
  return (
    <Page
      title="Top bar"
      note="The repo and the exact commit it was analyzed at, search in the middle, and the actions. Trace is the one primary button."
    >
      {row("Default", <TopBar repo={sampleRepo} branch="main" />)}
      {row(
        "Viewing a pull request, two filters on",
        <TopBar
          repo={sampleRepo}
          branch="PR #12"
          diff={{ value: view, onChange: setView }}
          filterCount={2}
          mac
        />,
      )}
      {row("Tracing", <TopBar repo={sampleRepo} branch="main" tracing />)}
    </Page>
  );
}

function RouteInspector({ onSelect }: { onSelect?: (id: string) => void }) {
  const route = sampleOf("route").node;
  return (
    <Inspector>
      <InspectorHeader node={route} location="apps/api/src/routes/orders.ts:14" />
      <InspectorSummary>
        Handles <code>POST /api/orders</code> in api. Called from 2 places in web; writes Order
        through <code>createOrder</code>.
      </InspectorSummary>
      <InspectorSection title="Facts">
        <FactList facts={routeFacts} />
      </InspectorSection>
      <InspectorSection title="Called by" count={routeCalledBy.length}>
        <ConnectionList
          items={routeCalledBy}
          empty="Nothing in the repo calls this."
          onSelect={onSelect}
        />
      </InspectorSection>
      <InspectorSection title="Calls" count={routeCalls.length}>
        <ConnectionList items={routeCalls} empty="This calls nothing in the repo." />
      </InspectorSection>
      <InspectorSection title="Code">
        <CodePreview {...routeCode} href={githubLineUrl(sampleRepo, routeCode.path, 14)} />
      </InspectorSection>
      <InspectorActions>
        <Button variant="primary" size="sm" icon="trace">
          Trace from here
        </Button>
        <LinkButton
          href={githubLineUrl(sampleRepo, routeCode.path, 14) ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
          variant="quiet"
          size="sm"
          trailingIcon="open-external"
        >
          Open on GitHub
        </LinkButton>
      </InspectorActions>
    </Inspector>
  );
}

function UnresolvedInspector() {
  const node = sampleOf("unresolved").node;
  return (
    <Inspector>
      <InspectorHeader node={node} layer="frontend" location="apps/web/lib/cms.ts:12" />
      <InspectorSummary>
        {nodeSubtitle(node).text}, so the request can't be matched to a route. It's shown, not
        dropped.
      </InspectorSummary>
      <InspectorSection title="Facts">
        <FactList
          facts={[
            { label: "Reason", value: "URL built at runtime" },
            { label: "Expression", value: "`${CMS_URL}/posts`", code: true },
            { label: "Env variable", value: "CMS_URL", code: true },
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Calls" count={0}>
        <ConnectionList items={[]} empty="Unknown until CMS_URL is set at runtime." />
      </InspectorSection>
    </Inspector>
  );
}

function ServiceInspector() {
  const api = sampleOf("service");
  return (
    <Inspector>
      <InspectorHeader node={api.node} />
      <InspectorSummary>
        A Next.js app in <code>apps/web</code> with 14 pages. It sends requests to api and calls 1
        outside API.
      </InspectorSummary>
      <InspectorSection title="Facts">
        <FactList
          facts={[
            { label: "Framework", value: "Next.js" },
            { label: "Root", value: "apps/web", code: true },
            { label: "Pages", value: "14" },
            { label: "Unresolved calls", value: "2" },
          ]}
        />
      </InspectorSection>
      <InspectorActions>
        <Button variant="primary" size="sm" icon="break-down" shortcut={["Enter"]}>
          Break down
        </Button>
      </InspectorActions>
    </Inspector>
  );
}

function InspectorSheet() {
  const panel = (children: ReactNode) => (
    <div
      style={{
        width: 360,
        height: 980,
        border: `1px solid ${cssVar("border")}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
  return (
    <Page
      title="Inspector"
      note="Context for the selection: what it is, a sentence from the code, facts, connections in the canvas's line styles, and the source at the analyzed commit."
    >
      <div style={{ display: "flex", gap: cssVar("space-24"), alignItems: "flex-start" }}>
        {panel(<RouteInspector />)}
        {panel(<UnresolvedInspector />)}
        {panel(<ServiceInspector />)}
      </div>
      <div style={{ display: "flex", gap: cssVar("space-24"), alignItems: "flex-start" }}>
        {(["loading", "failed"] as const).map((status) => (
          <div key={status} style={{ display: "grid", gap: cssVar("space-8"), width: 320 }}>
            <span style={muted}>
              {status === "loading" ? "Code on its way" : "Code that couldn't load"}
            </span>
            <CodePreview
              path={routeCode.path}
              startLine={14}
              lines={[]}
              highlight={14}
              href={githubLineUrl(sampleRepo, routeCode.path, 14)}
              status={status}
            />
          </div>
        ))}
      </div>
    </Page>
  );
}

/** A canvas-colored stage with overlays pinned to its corners, as in the explorer. */
function Stage({
  width,
  height,
  children,
}: {
  width: number | string;
  height: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        border: `1px solid ${cssVar("border")}`,
        borderRadius: 10,
        overflow: "hidden",
        background: cssVar("canvas"),
      }}
    >
      {children}
    </div>
  );
}

const pin = (place: CSSProperties): CSSProperties => ({ position: "absolute", ...place });

/** The legend toggle that sits beside the minimap (UX.md: "always one click away"). */
function LegendButton({ open, onToggle }: { open: boolean; onToggle?: () => void }) {
  return (
    <div className="gi-overlay">
      <Button variant="quiet" size="sm" icon="legend" aria-expanded={open} onClick={onToggle}>
        Legend
      </Button>
    </div>
  );
}

function OverlaySheet() {
  const [legend, setLegend] = useState(true);
  return (
    <Page
      title="Canvas overlays"
      note="Status top-left, zoom top-right, the drill-down path bottom-left, the minimap and legend bottom-right."
    >
      <Stage width={1080} height={640}>
        <div style={pin({ top: 16, left: 16 })}>
          <StatusChip tone="trace" exitLabel="Exit trace">
            Tracing <code style={{ fontFamily: cssVar("font-mono") }}>/checkout</code>
          </StatusChip>
        </div>
        <div style={pin({ top: 16, right: 16 })}>
          <ZoomControls zoom={0.75} />
        </div>
        <div style={pin({ bottom: 16, left: 16 })}>
          <Breadcrumbs items={sampleCrumbs} />
        </div>
        <div
          style={pin({
            bottom: 16,
            right: 16,
            display: "grid",
            justifyItems: "end",
            gap: cssVar("space-8"),
          })}
        >
          {legend && <Legend onClose={() => setLegend(false)} />}
          <div style={{ display: "flex", alignItems: "flex-end", gap: cssVar("space-8") }}>
            <LegendButton open={legend} onToggle={() => setLegend(!legend)} />
            <Minimap nodes={minimapNodes} viewport={{ x: 300, y: -40, width: 640, height: 420 }} />
          </div>
        </div>
      </Stage>
    </Page>
  );
}

function PaletteSheet({ empty = false }: { empty?: boolean }) {
  const [query, setQuery] = useState(empty ? "cms webhook" : "ord");
  const [active, setActive] = useState(0);
  const results = empty || !query ? [] : paletteResults;
  return (
    <div style={{ minHeight: "100vh", background: cssVar("canvas") }}>
      <TopBar repo={sampleRepo} branch="main" />
      <CommandPalette
        query={query}
        results={results}
        activeIndex={active}
        onQueryChange={(q) => {
          setQuery(q);
          setActive(0);
        }}
        onActiveIndexChange={setActive}
      />
    </div>
  );
}

/* Chrome around a small diagram: the explorer's layout (UX.md), drawn statically. */

interface Placed {
  key: string;
  x: number;
  y: number;
  width: number;
  node: ReturnType<typeof sampleOf>;
  selected?: boolean;
  layer?: "frontend" | "backend";
}

function LayoutSheet() {
  const nodes: Placed[] = [
    { key: "web", x: 24, y: 136, width: 220, node: sampleOf("service") },
    { key: "route", x: 480, y: 156, width: 236, node: sampleOf("route"), selected: true },
    { key: "handler", x: 480, y: 330, width: 236, node: sampleOf("symbol"), layer: "backend" },
    { key: "model", x: 896, y: 330, width: 168, node: sampleOf("model") },
    { key: "store", x: 912, y: 490, width: 136, node: sampleOf("datastore") },
  ];
  const edges: { edge: EdgeLike; points: Point[]; layer: "frontend" | "backend" | "data" }[] = [
    {
      edge: { kind: "http", confidence: "exact", label: "POST /api/orders" },
      layer: "frontend",
      points: [
        { x: 244, y: 180 },
        { x: 480, y: 180 },
      ],
    },
    {
      edge: { kind: "handles", confidence: "exact" },
      layer: "backend",
      points: [
        { x: 598, y: 204 },
        { x: 598, y: 330 },
      ],
    },
    {
      edge: { kind: "writes", confidence: "pattern", fields: ["total", "status"] },
      layer: "backend",
      points: [
        { x: 716, y: 354 },
        { x: 896, y: 354 },
      ],
    },
    {
      edge: { kind: "stores", confidence: "exact" },
      layer: "data",
      points: [
        { x: 980, y: 378 },
        { x: 980, y: 490 },
      ],
    },
  ];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        height: "100vh",
        minHeight: 760,
        background: cssVar("canvas"),
      }}
    >
      <TopBar repo={sampleRepo} branch="main" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
        <div style={{ position: "relative", overflow: "hidden" }}>
          <div style={pin({ inset: 0 })}>
            <svg width="100%" height="100%" style={pin({ inset: 0, overflow: "visible" })}>
              {edges.map((e, i) => (
                <DiagramEdge
                  key={i}
                  edge={e.edge}
                  points={e.points}
                  layer={e.layer}
                  ends={{ from: "", to: "" }}
                  selected={i === 0}
                />
              ))}
            </svg>
            {nodes.map((p) => (
              <div key={p.key} style={pin({ left: p.x, top: p.y, width: p.width })}>
                <DiagramNode
                  node={p.node.node}
                  layer={p.layer ?? p.node.layer}
                  counts={p.node.counts}
                  selected={p.selected ?? false}
                  style={p.node.node.kind === "datastore" ? {} : { width: "100%" }}
                />
              </div>
            ))}
            {edges.map((e, i) => {
              const { mid } = edgeGeometry(e.points);
              return (
                <EdgeLabel
                  key={i}
                  edge={e.edge}
                  layer={e.layer}
                  selected={i === 0}
                  style={{ left: mid.x, top: mid.y }}
                />
              );
            })}
          </div>
          <div style={pin({ top: 16, right: 16 })}>
            <ZoomControls zoom={1} />
          </div>
          <div style={pin({ bottom: 16, left: 16 })}>
            <Breadcrumbs items={sampleCrumbs.slice(0, 2)} />
          </div>
          <div
            style={pin({ bottom: 16, right: 16, display: "flex", alignItems: "flex-end", gap: 8 })}
          >
            <LegendButton open={false} />
            <Minimap nodes={minimapNodes} viewport={{ x: -40, y: -20, width: 1100, height: 680 }} />
          </div>
        </div>
        <RouteInspector />
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Components/Chrome",
};

export default meta;
type Story = StoryObj;

/** Buttons, switches, the segmented control, keys, chips, and status chips. */
export const Controls: Story = { render: () => <ControlSheet /> };

/** The top bar: default, viewing a pull request, and tracing. */
export const TopBars: Story = { name: "Top bar", render: () => <TopBarSheet /> };

/** The inspector for a route, an unresolved call, and a service. */
export const Inspectors: Story = { name: "Inspector", render: () => <InspectorSheet /> };

/** Breadcrumbs, zoom, a status chip, the minimap, and the legend on a canvas. */
export const Overlays: Story = { name: "Canvas overlays", render: () => <OverlaySheet /> };

/** The command palette with results for "ord". */
export const Palette: Story = { name: "Command palette", render: () => <PaletteSheet /> };

/** The command palette when nothing matches. */
export const PaletteEmpty: Story = {
  name: "Command palette, no results",
  render: () => <PaletteSheet empty />,
};

/** The chrome around a small diagram, laid out as the explorer will be. */
export const Layout: Story = { render: () => <LayoutSheet /> };
