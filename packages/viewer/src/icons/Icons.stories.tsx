import type { GraphNode } from "@gitinside/schema";
import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties, ReactNode } from "react";
import { cssVar } from "../tokens.js";
import type { Theme } from "../ViewerRoot.js";
import { brandFill, brands, MONOCHROME } from "./brands.js";
import { Glyph, glyphNames, glyphs } from "./glyphs.js";
import { BrandLogo, iconFor, iconLabel, IconTile, NodeIconTile, TILE_ICON_SIZE } from "./Icon.js";

// Every icon in the system, in whichever theme the toolbar selects: the glyph
// family at its grid size and on tiles, every mapped logo with the fill it
// gets, and the icon each node kind resolves to.

const muted: CSSProperties = { color: cssVar("text-muted"), fontSize: cssVar("font-size-12") };
const mono: CSSProperties = { fontFamily: cssVar("font-mono"), fontSize: cssVar("font-size-12") };

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

const grid = (min: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
  gap: cssVar("space-12"),
});

const cell: CSSProperties = {
  display: "grid",
  gap: cssVar("space-12"),
  justifyItems: "center",
  padding: `${cssVar("space-16")} ${cssVar("space-12")}`,
  border: `1px solid ${cssVar("border")}`,
  borderRadius: cssVar("radius-card"),
};

function GlyphSheet() {
  return (
    <Page
      title="Glyphs"
      note="One family for generic kinds: 24px grid, 1.5px round strokes. Shown at grid size, then on small and large tiles."
    >
      <div style={grid(176)}>
        {glyphNames.map((name) => (
          <div key={name} style={cell}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: cssVar("space-16"),
                color: cssVar("text"),
              }}
            >
              <Glyph name={name} />
              <IconTile>
                <Glyph name={name} size={TILE_ICON_SIZE.sm} />
              </IconTile>
              <IconTile size="lg">
                <Glyph name={name} size={TILE_ICON_SIZE.lg} />
              </IconTile>
            </div>
            <div style={{ display: "grid", gap: cssVar("space-4"), justifyItems: "center" }}>
              <span style={{ fontSize: cssVar("font-size-13") }}>{glyphs[name].label}</span>
              <span style={{ ...mono, color: cssVar("text-muted") }}>{name}</span>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

function LogoSheet({ theme }: { theme: Theme }) {
  return (
    <Page
      title="Logos"
      note="Simple Icons, on a neutral tile. A brand color under 3:1 on the tile falls back to the text color."
    >
      <div style={grid(140)}>
        {brands.map((b) => {
          const fill = brandFill(b, theme);
          return (
            <div key={b.slug} style={cell}>
              <IconTile size="lg">
                <BrandLogo brand={b} size={TILE_ICON_SIZE.lg} title={null} />
              </IconTile>
              <div style={{ display: "grid", gap: cssVar("space-4"), justifyItems: "center" }}>
                <span style={{ fontSize: cssVar("font-size-13") }}>{b.title}</span>
                <span style={{ ...mono, color: cssVar("text-muted") }}>
                  {fill === MONOCHROME ? "monochrome" : fill}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}

const base = { parentId: "system:root" };
const samples: { node: GraphNode; from: string }[] = [
  {
    node: {
      ...base,
      id: "s1",
      kind: "service",
      label: "web",
      root: "apps/web",
      framework: "next",
      layer: "frontend",
    },
    from: "framework: next",
  },
  {
    node: {
      ...base,
      id: "s2",
      kind: "service",
      label: "api",
      root: "apps/api",
      framework: "express",
      layer: "backend",
    },
    from: "framework: express",
  },
  {
    node: { ...base, id: "s3", kind: "service", label: "worker", root: "apps/worker" },
    from: "no framework",
  },
  {
    node: { ...base, id: "m", kind: "module", label: "lib", path: "apps/web/lib" },
    from: "module",
  },
  {
    node: {
      ...base,
      id: "f",
      kind: "file",
      label: "api.ts",
      path: "apps/web/lib/api.ts",
      hash: "0".repeat(64),
    },
    from: "file",
  },
  {
    node: {
      ...base,
      id: "y1",
      kind: "symbol",
      label: "createOrder",
      symbolKind: "function",
      exported: true,
    },
    from: "symbol: function",
  },
  {
    node: {
      ...base,
      id: "y2",
      kind: "symbol",
      label: "OrderService",
      symbolKind: "class",
      exported: true,
    },
    from: "symbol: class",
  },
  {
    node: {
      ...base,
      id: "y3",
      kind: "symbol",
      label: "OrderService.list",
      symbolKind: "method",
      exported: false,
    },
    from: "symbol: method",
  },
  {
    node: {
      ...base,
      id: "y4",
      kind: "symbol",
      label: "API_BASE",
      symbolKind: "variable",
      exported: true,
    },
    from: "symbol: variable",
  },
  {
    node: {
      ...base,
      id: "r",
      kind: "route",
      label: "POST /api/orders",
      method: "POST",
      path: "/api/orders",
      layer: "backend",
    },
    from: "route",
  },
  {
    node: {
      ...base,
      id: "p",
      kind: "page",
      label: "/checkout",
      path: "/checkout",
      layer: "frontend",
    },
    from: "page",
  },
  {
    node: { ...base, id: "md", kind: "model", label: "Order", fields: [], layer: "data" },
    from: "model",
  },
  {
    node: {
      ...base,
      id: "d1",
      kind: "datastore",
      label: "postgres",
      engine: "postgres",
      layer: "data",
    },
    from: "engine: postgres",
  },
  {
    node: {
      ...base,
      id: "d2",
      kind: "datastore",
      label: "mssql",
      engine: "sqlserver",
      layer: "data",
    },
    from: "engine: sqlserver (no logo)",
  },
  {
    node: {
      ...base,
      id: "q1",
      kind: "queue",
      label: "emails",
      engine: "redis",
      name: "emails",
      layer: "infra",
    },
    from: "engine: redis",
  },
  {
    node: { ...base, id: "q2", kind: "queue", label: "events", engine: "redpanda", layer: "infra" },
    from: "engine: redpanda (no logo)",
  },
  {
    node: {
      ...base,
      id: "e1",
      kind: "external",
      label: "api.stripe.com",
      host: "api.stripe.com",
      layer: "external",
    },
    from: "host: api.stripe.com",
  },
  {
    node: {
      ...base,
      id: "e2",
      kind: "external",
      label: "api.openai.com",
      host: "api.openai.com",
      layer: "external",
    },
    from: "host: api.openai.com (no logo)",
  },
  {
    node: {
      ...base,
      id: "u",
      kind: "unresolved",
      label: "fetch(url)",
      reason: "DYNAMIC_URL",
      expression: "url",
    },
    from: "unresolved",
  },
];

function MappingSheet() {
  return (
    <Page
      title="Node icons"
      note="Technology when the node's own field names one, otherwise its kind's glyph. Tiles are ringed by layer."
    >
      <div style={grid(300)}>
        {samples.map(({ node, from }) => (
          <div
            key={node.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: cssVar("space-12"),
              padding: cssVar("space-12"),
              border: `1px solid ${cssVar("border")}`,
              borderRadius: cssVar("radius-card"),
            }}
          >
            <NodeIconTile
              node={node}
              size={["datastore", "queue", "external"].includes(node.kind) ? "lg" : "sm"}
            />
            <div style={{ display: "grid", gap: cssVar("space-4"), minWidth: 0 }}>
              <span
                style={{
                  fontSize: cssVar("font-size-14"),
                  fontWeight: cssVar("font-weight-medium"),
                }}
              >
                {node.label}
              </span>
              <span style={muted}>
                {from} → {iconLabel(iconFor(node))}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

const meta: Meta = {
  title: "Foundations/Icons",
};

export default meta;
type Story = StoryObj;

/** Every glyph in the custom set. */
export const Glyphs: Story = { render: () => <GlyphSheet /> };

/** Every mapped technology logo, with the fill it gets in the selected theme. */
export const Logos: Story = {
  render: (_args, context) => (
    <LogoSheet theme={(context.globals["theme"] as Theme | undefined) ?? "dark"} />
  ),
};

/** The icon each node kind resolves to, from the field that decides it. */
export const Mapping: Story = { render: () => <MappingSheet /> };
