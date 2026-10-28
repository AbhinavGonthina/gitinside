import type { GraphNode } from "@gitinside/schema";
import { composeStories } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio } from "../contrast.js";
import { themeTokens } from "../tokens.js";
import { ViewerRoot } from "../ViewerRoot.js";
import {
  brandFill,
  brandForEngine,
  brandForFramework,
  brandForHost,
  brands,
  MONOCHROME,
  TILE_SURFACES,
} from "./brands.js";
import { Glyph, glyphNames, glyphs, type GlyphName } from "./glyphs.js";
import {
  BrandLogo,
  iconFor,
  iconLabel,
  IconTile,
  NodeIcon,
  NodeIconTile,
  TILE_ICON_SIZE,
} from "./Icon.js";
import * as stories from "./Icons.stories.js";

afterEach(cleanup);

const base = { label: "x", parentId: "system:root" };

describe("brand lookup", () => {
  it.each([
    ["next", "nextdotjs"],
    ["express", "express"],
    ["react", "react"],
  ])("maps the analyzer's framework %s to %s", (framework, slug) => {
    expect(brandForFramework(framework)?.slug).toBe(slug);
  });

  it("has no logo for a missing or unknown framework", () => {
    expect(brandForFramework(undefined)).toBeUndefined();
    expect(brandForFramework("remix")).toBeUndefined();
  });

  // Every engine the analyzer can emit (infra.ts IMAGE_NAMES/SCHEME_ENGINES,
  // prisma.ts ENGINES, queues.ts), with the logo it gets or null for the glyph.
  it.each([
    ["clickhouse", "clickhouse"],
    ["cockroachdb", "cockroachlabs"],
    ["elasticsearch", "elasticsearch"],
    ["kafka", "apachekafka"],
    ["meilisearch", "meilisearch"],
    ["memcached", null],
    ["minio", "minio"],
    ["mongo", "mongodb"],
    ["mysql", "mysql"],
    ["nats", "natsdotio"],
    ["opensearch", "opensearch"],
    ["postgres", "postgresql"],
    ["rabbitmq", "rabbitmq"],
    ["redis", "redis"],
    ["redpanda", null],
    ["sqlite", "sqlite"],
    ["sqlserver", null],
    ["typesense", null],
  ])("maps engine %s to %s", (engine, slug) => {
    expect(brandForEngine(engine)?.slug ?? null).toBe(slug);
  });

  // The hosts of the SDK allowlist (sdk.ts), with the logo or null for the glyph.
  it.each([
    ["api.anthropic.com", "anthropic"],
    ["generativelanguage.googleapis.com", "googlegemini"],
    ["www.googleapis.com", "google"],
    ["api.hubapi.com", "hubspot"],
    ["api.github.com", "github"],
    ["api.mailgun.net", "mailgun"],
    ["api.resend.com", "resend"],
    ["api.stripe.com", "stripe"],
    ["api.openai.com", null],
    ["api.sendgrid.com", null],
    ["slack.com", null],
    ["api.twilio.com", null],
    ["api.postmarkapp.com", null],
    ["s3.amazonaws.com", null],
  ])("maps SDK host %s to %s", (host, slug) => {
    expect(brandForHost(host)?.slug ?? null).toBe(slug);
  });

  it("matches subdomains, ignores case, port, and a trailing dot", () => {
    expect(brandForHost("files.stripe.com")?.slug).toBe("stripe");
    expect(brandForHost("API.Stripe.COM:8443")?.slug).toBe("stripe");
    expect(brandForHost("stripe.com.")?.slug).toBe("stripe");
    expect(brandForHost("raw.githubusercontent.com")?.slug).toBe("github");
  });

  it("prefers the longest suffix", () => {
    expect(brandForHost("maps.googleapis.com")?.slug).toBe("googlemaps");
    expect(brandForHost("tile.maps.googleapis.com")?.slug).toBe("googlemaps");
    expect(brandForHost("oauth2.googleapis.com")?.slug).toBe("google");
  });

  it("only matches at a label boundary", () => {
    expect(brandForHost("notstripe.com")).toBeUndefined();
    expect(brandForHost("box.com")).toBeUndefined();
    expect(brandForHost("stripe.com.evil.example")).toBeUndefined();
    expect(brandForHost("com")).toBeUndefined();
    expect(brandForHost("localhost:3000")).toBeUndefined();
    expect(brandForHost("10.0.0.1")).toBeUndefined();
  });

  it("lists every logo once, sorted by slug, with a #rrggbb color and a path", () => {
    const slugs = brands.map((b) => b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual(slugs);
    for (const b of brands) {
      expect(b.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(b.path.length).toBeGreaterThan(0);
      expect(b.title.length).toBeGreaterThan(0);
    }
  });
});

describe("brandFill", () => {
  it.each(["dark", "light"] as const)(
    "keeps every %s fill at 3:1 on every tile surface, or falls back to text",
    (theme) => {
      for (const b of brands) {
        const fill = brandFill(b, theme);
        if (fill === MONOCHROME) {
          expect(
            TILE_SURFACES.some((s) => contrastRatio(b.hex, themeTokens[theme][s]) < 3),
            `${b.slug} fell back without failing`,
          ).toBe(true);
          for (const s of TILE_SURFACES) {
            expect(contrastRatio(themeTokens[theme].text, themeTokens[theme][s])).toBeGreaterThan(
              4.5,
            );
          }
        } else {
          expect(fill).toBe(b.hex);
          for (const s of TILE_SURFACES) {
            expect(contrastRatio(fill, themeTokens[theme][s])).toBeGreaterThanOrEqual(3);
          }
        }
      }
    },
  );

  it("draws a black mark black on light tiles and in text color on dark ones", () => {
    const next = brandForFramework("next")!;
    expect(brandFill(next, "light")).toBe(next.hex);
    expect(brandFill(next, "dark")).toBe(MONOCHROME);
  });

  it("keeps a mid-tone brand color in both themes", () => {
    const postgres = brandForEngine("postgres")!;
    expect(brandFill(postgres, "dark")).toBe("#4169e1");
    expect(brandFill(postgres, "light")).toBe("#4169e1");
  });
});

describe("iconFor", () => {
  const cases: [GraphNode, string][] = [
    [{ ...base, id: "system:root", kind: "system", parentId: null }, "glyph:service"],
    [
      { ...base, id: "s1", kind: "service", root: "apps/web", framework: "next" },
      "brand:nextdotjs",
    ],
    [{ ...base, id: "s2", kind: "service", root: "apps/x", framework: "fastify" }, "glyph:service"],
    [{ ...base, id: "s3", kind: "service", root: "." }, "glyph:service"],
    [{ ...base, id: "m", kind: "module", path: "src" }, "glyph:module"],
    [{ ...base, id: "f", kind: "file", path: "a.ts", hash: "0".repeat(64) }, "glyph:file"],
    [
      { ...base, id: "y1", kind: "symbol", symbolKind: "function", exported: true },
      "glyph:function",
    ],
    [{ ...base, id: "y2", kind: "symbol", symbolKind: "class", exported: true }, "glyph:class"],
    [{ ...base, id: "y3", kind: "symbol", symbolKind: "method", exported: false }, "glyph:method"],
    [
      { ...base, id: "y4", kind: "symbol", symbolKind: "variable", exported: true },
      "glyph:variable",
    ],
    [{ ...base, id: "r", kind: "route", method: "GET", path: "/a" }, "glyph:route"],
    [{ ...base, id: "p", kind: "page", path: "/" }, "glyph:page"],
    [{ ...base, id: "md", kind: "model", fields: [] }, "glyph:model"],
    [{ ...base, id: "d1", kind: "datastore", engine: "postgres" }, "brand:postgresql"],
    [{ ...base, id: "d2", kind: "datastore", engine: "sqlserver" }, "glyph:datastore"],
    [{ ...base, id: "q1", kind: "queue", engine: "redis", name: "emails" }, "brand:redis"],
    [{ ...base, id: "q2", kind: "queue", engine: "redpanda" }, "glyph:queue"],
    [{ ...base, id: "e1", kind: "external", host: "api.stripe.com" }, "brand:stripe"],
    [{ ...base, id: "e2", kind: "external", host: "api.openai.com" }, "glyph:external"],
    [
      { ...base, id: "u", kind: "unresolved", reason: "DYNAMIC_URL", expression: "url" },
      "glyph:unresolved",
    ],
  ];

  it.each(cases)("picks the icon for %j", (node, expected) => {
    const choice = iconFor(node);
    expect(choice.type === "brand" ? `brand:${choice.brand.slug}` : `glyph:${choice.glyph}`).toBe(
      expected,
    );
  });

  it("uses every glyph for some node", () => {
    const used = new Set(
      cases.map(([n]) => iconFor(n)).flatMap((c) => (c.type === "glyph" ? [c.glyph] : [])),
    );
    expect([...used].sort()).toEqual([...glyphNames].sort());
  });

  it("labels choices by brand title or glyph kind", () => {
    expect(iconLabel(iconFor(cases[1]![0]))).toBe("Next.js");
    expect(iconLabel(iconFor(cases[10]![0]))).toBe("Route");
  });
});

describe("Glyph", () => {
  it.each(glyphNames)("draws %s on the 24px grid with 1.5px round strokes", (name: GlyphName) => {
    const { container } = render(<Glyph name={name} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.getAttribute("stroke-linecap")).toBe("round");
    expect(svg.getAttribute("stroke-linejoin")).toBe("round");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.children.length).toBeGreaterThan(0);
    // No element brings its own paint, so the family stays one weight and color.
    for (const el of svg.querySelectorAll("*")) {
      for (const attr of ["fill", "stroke", "stroke-width", "style", "transform"]) {
        expect(el.hasAttribute(attr), `${name} <${el.tagName}> ${attr}`).toBe(false);
      }
    }
  });

  it("keeps every coordinate inside the grid", () => {
    for (const name of glyphNames) {
      const { container } = render(<Glyph name={name} />);
      for (const el of container.querySelectorAll("path, rect, circle, ellipse")) {
        const numbers = [...el.attributes]
          .filter((a) => a.name !== "d")
          .map((a) => Number(a.value))
          .filter((n) => !Number.isNaN(n));
        for (const n of numbers) expect(n, name).toBeLessThanOrEqual(24);
        for (const n of numbers) expect(n, name).toBeGreaterThanOrEqual(0);
      }
      cleanup();
    }
  });

  it("is a named image when given a title", () => {
    const { getByRole } = render(<Glyph name="queue" title="Queue: emails" size={16} />);
    const svg = getByRole("img", { name: "Queue: emails" });
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.querySelector("title")?.textContent).toBe("Queue: emails");
  });

  it("gives every glyph a label", () => {
    for (const name of glyphNames) expect(glyphs[name].label.length).toBeGreaterThan(0);
  });
});

describe("BrandLogo", () => {
  const stripe = brandForHost("api.stripe.com")!;
  const next = brandForFramework("next")!;

  it("is labeled with the brand title by default", () => {
    const { getByRole } = render(<BrandLogo brand={stripe} />);
    const svg = getByRole("img", { name: "Stripe" });
    expect(svg.getAttribute("data-brand")).toBe("stripe");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(stripe.path);
  });

  it("sets both theme fills as custom properties", () => {
    const { container } = render(<BrandLogo brand={next} />);
    const svg = container.querySelector("svg")!;
    expect(svg.style.getPropertyValue("--gi-brand-dark")).toBe(MONOCHROME);
    expect(svg.style.getPropertyValue("--gi-brand-light")).toBe(next.hex);
    expect(svg.getAttribute("fill")).toBe("currentColor");
  });

  it("can be decorative or custom-labeled", () => {
    const { container, rerender, getByRole } = render(<BrandLogo brand={stripe} title={null} />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("title")).toBeNull();
    rerender(<BrandLogo brand={stripe} title="Payments: Stripe" />);
    expect(getByRole("img", { name: "Payments: Stripe" })).toBeTruthy();
  });
});

describe("NodeIcon and tiles", () => {
  const store: GraphNode = {
    ...base,
    id: "datastore:infra/db",
    kind: "datastore",
    engine: "postgres",
    layer: "data",
  };
  const file: GraphNode = { ...base, id: "f", kind: "file", path: "a.ts", hash: "0".repeat(64) };

  it("renders a logo or a glyph, decorative unless titled", () => {
    const { container, rerender, getByRole } = render(<NodeIcon node={store} />);
    expect(container.querySelector("[data-brand=postgresql]")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
    rerender(<NodeIcon node={file} title="a.ts" size={20} />);
    expect(getByRole("img", { name: "a.ts" }).getAttribute("data-glyph")).toBe("file");
    rerender(<NodeIcon node={store} title="db" />);
    expect(getByRole("img", { name: "db" }).getAttribute("data-brand")).toBe("postgresql");
  });

  it("rings a node's tile in its layer and sizes the icon to the tile", () => {
    const { container } = render(<NodeIconTile node={store} size="lg" />);
    const tile = container.querySelector(".gi-icon-tile")!;
    expect(tile.getAttribute("data-layer")).toBe("data");
    expect(tile.getAttribute("data-size")).toBe("lg");
    expect(tile.querySelector("svg")!.getAttribute("width")).toBe(String(TILE_ICON_SIZE.lg));
  });

  it("leaves a tile unringed without a layer", () => {
    const { container } = render(
      <IconTile>
        <Glyph name="file" />
      </IconTile>,
    );
    const tile = container.querySelector(".gi-icon-tile")!;
    expect(tile.hasAttribute("data-layer")).toBe(false);
    expect(tile.getAttribute("data-size")).toBe("sm");
  });
});

describe("Icons stories", () => {
  const { Glyphs, Logos, Mapping } = composeStories(stories);

  it("show every glyph", () => {
    const { container } = render(<Glyphs />);
    const shown = new Set(
      [...container.querySelectorAll("[data-glyph]")].map((e) => e.getAttribute("data-glyph")),
    );
    expect([...shown].sort()).toEqual([...glyphNames].sort());
  });

  it("show every logo", () => {
    const { container } = render(
      <ViewerRoot>
        <Logos />
      </ViewerRoot>,
    );
    const shown = new Set(
      [...container.querySelectorAll("[data-brand]")].map((e) => e.getAttribute("data-brand")),
    );
    expect([...shown].sort()).toEqual(brands.map((b) => b.slug));
  });

  it("show the mapping for each node kind", () => {
    const { container } = render(<Mapping />);
    expect(container.querySelectorAll(".gi-icon-tile").length).toBeGreaterThanOrEqual(12);
  });
});
