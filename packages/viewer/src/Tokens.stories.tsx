import type { Meta, StoryObj } from "@storybook/react";
import type { CSSProperties, ReactNode } from "react";
import { contrastRatio } from "./contrast.js";
import { cssVar, scaleTokens, themeTokens, type ThemeTokenName } from "./tokens.js";
import type { Theme } from "./ViewerRoot.js";

// A reference sheet for the tokens, rendered with the tokens themselves. The
// contrast figures are computed live, so the sheet can't drift from the values.

const groups: { title: string; note: string; names: ThemeTokenName[]; against?: ThemeTokenName }[] =
  [
    {
      title: "Surfaces",
      note: "Solid canvas; depth comes from container tints, never patterns.",
      names: ["canvas", "surface-1", "surface-2", "surface-raised", "border"],
    },
    {
      title: "Text",
      note: "At least 4.5:1 on every surface.",
      names: ["text", "text-muted"],
      against: "canvas",
    },
    {
      title: "Layers",
      note: "Accents for frame tints, tile rings, and edge flow; never a full fill.",
      names: ["layer-frontend", "layer-backend", "layer-data", "layer-infra", "layer-external"],
      against: "canvas",
    },
    {
      title: "Signals",
      note: "Selection and focus, trace, and diff mode. At least 3:1 on every surface.",
      names: ["accent", "trace", "diff-added", "diff-changed", "diff-removed"],
      against: "canvas",
    },
  ];

const label: CSSProperties = {
  fontSize: cssVar("font-size-13"),
  fontWeight: cssVar("font-weight-medium"),
};
const muted: CSSProperties = { color: cssVar("text-muted"), fontSize: cssVar("font-size-12") };
const mono: CSSProperties = { fontFamily: cssVar("font-mono"), fontSize: cssVar("font-size-12") };

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: cssVar("space-12"), alignContent: "start" }}>
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: cssVar("font-size-16"),
            fontWeight: cssVar("font-weight-semibold"),
          }}
        >
          {title}
        </h2>
        <p style={{ ...muted, margin: `${cssVar("space-4")} 0 0` }}>{note}</p>
      </div>
      {children}
    </section>
  );
}

function Swatch({
  theme,
  name,
  against,
}: {
  theme: Theme;
  name: ThemeTokenName;
  against?: ThemeTokenName;
}) {
  const value = themeTokens[theme][name];
  return (
    <div
      style={{
        display: "grid",
        gap: cssVar("space-8"),
        padding: cssVar("space-12"),
        background: cssVar("surface-1"),
        border: `1px solid ${cssVar("border")}`,
        borderRadius: cssVar("radius-card"),
      }}
    >
      <div
        style={{
          height: 40,
          borderRadius: cssVar("radius-chip"),
          background: cssVar(name),
          boxShadow: `inset 0 0 0 1px ${cssVar("border")}`,
        }}
      />
      <div style={label}>{name}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: cssVar("space-8") }}>
        <span style={{ ...mono, color: cssVar("text-muted") }}>{value}</span>
        {against && (
          <span style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
            {contrastRatio(value, themeTokens[theme][against]).toFixed(1)}:1
          </span>
        )}
      </div>
    </div>
  );
}

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))",
  gap: cssVar("space-12"),
};

function TokenSheet({ theme }: { theme: Theme }) {
  const sizes = Object.keys(scaleTokens).filter((n) =>
    n.startsWith("font-size-"),
  ) as (keyof typeof scaleTokens)[];
  const spaces = Object.keys(scaleTokens).filter((n) =>
    n.startsWith("space-"),
  ) as (keyof typeof scaleTokens)[];
  const radii = Object.keys(scaleTokens).filter((n) =>
    n.startsWith("radius-"),
  ) as (keyof typeof scaleTokens)[];
  return (
    <div
      style={{
        display: "grid",
        gap: cssVar("space-32"),
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
          Design tokens
        </h1>
        <p style={{ margin: `${cssVar("space-8")} 0 0`, color: cssVar("text-muted") }}>
          {theme === "dark" ? "Dark (default)" : "Light"} theme. Contrast is measured against the
          canvas.
        </p>
      </header>

      {groups.map((g) => (
        <Section key={g.title} title={g.title} note={g.note}>
          <div style={grid}>
            {g.names.map((n) => (
              <Swatch
                key={n}
                theme={theme}
                name={n}
                {...(g.against ? { against: g.against } : {})}
              />
            ))}
          </div>
        </Section>
      ))}

      <Section
        title="Type"
        note="Geist for UI and body; Geist Mono only for code, paths, and routes."
      >
        <div style={{ display: "grid", gap: cssVar("space-8") }}>
          {sizes.map((n) => (
            <div
              key={n}
              style={{ display: "flex", alignItems: "baseline", gap: cssVar("space-16") }}
            >
              <span style={{ ...muted, width: 48, fontVariantNumeric: "tabular-nums" }}>
                {scaleTokens[n]}
              </span>
              <span style={{ fontSize: cssVar(n), fontWeight: cssVar("font-weight-medium") }}>
                Checkout service calls the orders API
              </span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "baseline", gap: cssVar("space-16") }}>
            <span style={{ ...muted, width: 48 }}>mono</span>
            <span style={{ fontFamily: cssVar("font-mono"), fontSize: cssVar("font-size-13") }}>
              POST /api/orders/:id · apps/web/src/lib/api.ts:42
            </span>
          </div>
          <div style={{ display: "flex", gap: cssVar("space-16"), ...muted }}>
            <span style={{ width: 48 }}>weights</span>
            <span style={{ fontWeight: cssVar("font-weight-regular") }}>Regular 400</span>
            <span style={{ fontWeight: cssVar("font-weight-medium") }}>Medium 500</span>
            <span style={{ fontWeight: cssVar("font-weight-semibold") }}>Semibold 600</span>
          </div>
        </div>
      </Section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: cssVar("space-32"),
        }}
      >
        <Section title="Spacing" note="4px base.">
          <div style={{ display: "grid", gap: cssVar("space-8") }}>
            {spaces.map((n) => (
              <div
                key={n}
                style={{ display: "flex", alignItems: "center", gap: cssVar("space-12") }}
              >
                <span style={{ ...muted, width: 40, fontVariantNumeric: "tabular-nums" }}>
                  {scaleTokens[n]}
                </span>
                <span
                  style={{
                    width: cssVar(n),
                    height: 12,
                    borderRadius: 2,
                    background: cssVar("accent"),
                  }}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius" note="By hierarchy, not one radius everywhere.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: cssVar("space-12") }}>
            {radii.map((n) => (
              <div
                key={n}
                style={{ display: "grid", gap: cssVar("space-4"), justifyItems: "center" }}
              >
                <div
                  style={{
                    width: 44,
                    height: 40,
                    borderRadius: cssVar(n),
                    background: cssVar("surface-2"),
                    border: `1px solid ${cssVar("border")}`,
                  }}
                />
                <span style={muted}>{n.slice("radius-".length)}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Elevation" note="1 is border only; 2 popovers; 3 the command palette.">
          <div style={{ display: "flex", gap: cssVar("space-16") }}>
            {(["1", "2", "3"] as const).map((level) => (
              <div
                key={level}
                style={{
                  width: 72,
                  height: 56,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: cssVar("radius-card"),
                  border: `1px solid ${cssVar("border")}`,
                  ...(level === "1"
                    ? { background: cssVar("surface-1") }
                    : {
                        background: cssVar("surface-raised"),
                        boxShadow: cssVar(level === "2" ? "shadow-2" : "shadow-3"),
                      }),
                  ...label,
                }}
              >
                {level}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

const meta: Meta<typeof TokenSheet> = {
  title: "Foundations/Tokens",
  component: TokenSheet,
  render: (_args, context) => <TokenSheet theme={context.globals["theme"] as Theme} />,
  args: { theme: "dark" },
  argTypes: { theme: { control: false } },
};

export default meta;
type Story = StoryObj<typeof TokenSheet>;

/** Every token, in whichever theme the toolbar selects. */
export const Sheet: Story = {};
