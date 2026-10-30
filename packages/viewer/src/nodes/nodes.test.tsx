import { NodeKind, UnresolvedReason, type GraphNode } from "@gitinside/schema";
import { composeStories } from "@storybook/react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IconTile, TILE_OUTLINES } from "../icons/Icon.js";
import { DiagramNode } from "./DiagramNode.js";
import {
  countText,
  kindName,
  modelFieldsText,
  nodeAccessibleName,
  nodeLabel,
  nodeShape,
  nodeSubtitle,
  nodeTier,
  REASON_TEXT,
} from "./describe.js";
import * as stories from "./Nodes.stories.js";
import { nodeSamples, nodeStates, sampleOf } from "./samples.js";

afterEach(cleanup);

const base = { label: "x", parentId: "system:root" };
const sample = (kind: GraphNode["kind"]): GraphNode => sampleOf(kind).node;

describe("nodeTier", () => {
  it.each([
    ["system", "frame"],
    ["service", "frame"],
    ["module", "frame"],
    ["file", "card"],
    ["symbol", "card"],
    ["route", "card"],
    ["page", "card"],
    ["model", "card"],
    ["unresolved", "card"],
    ["datastore", "icon"],
    ["queue", "icon"],
    ["external", "icon"],
  ] as const)("draws a %s as a %s", (kind, tier) => {
    const node =
      kind === "system"
        ? ({ ...base, id: "system:root", kind, parentId: null } as const)
        : sample(kind);
    expect(nodeTier(node)).toBe(tier);
  });
});

describe("nodeShape", () => {
  it.each([
    ["service", "window"],
    ["module", "folder"],
    ["file", "card"],
    ["symbol", "card"],
    ["route", "capsule"],
    ["page", "window"],
    ["model", "table"],
    ["unresolved", "dotted"],
    ["datastore", "cylinder"],
    ["queue", "pipe"],
    ["external", "circle"],
  ] as const)("draws a %s as a %s", (kind, shape) => {
    expect(nodeShape(sample(kind))).toBe(shape);
  });

  it("draws a frontend service as a window and any other service as a box (design gate)", () => {
    const svc = { ...base, id: "s", kind: "service", root: "apps/x" } as const;
    expect(nodeShape({ ...svc, layer: "frontend" })).toBe("window");
    expect(nodeShape({ ...svc, layer: "backend" })).toBe("box");
    expect(nodeShape({ ...svc, layer: "infra" })).toBe("box");
    expect(nodeShape(svc)).toBe("box");
    // The node's own layer wins over an inherited one.
    expect(nodeShape(svc, "frontend")).toBe("window");
    expect(nodeShape({ ...svc, layer: "backend" }, "frontend")).toBe("box");
  });

  it("gives every node kind a shape, and frontend and backend services different ones", () => {
    const shapes = new Set(nodeSamples.map((s) => nodeShape(s.node, s.layer)));
    expect(shapes.size).toBe(10);
  });

  it("lists a model's fields in declaration order, marking optional ones", () => {
    expect(modelFieldsText(sample("model"))).toBe(
      "id · total · status · userId · note? · createdAt",
    );
    expect(modelFieldsText({ ...base, id: "md", kind: "model", fields: [] })).toBe("");
    expect(modelFieldsText(sample("file"))).toBe("");
  });
});

describe("describe", () => {
  it("names symbols by their symbol kind", () => {
    expect(
      nodeSamples.filter((s) => s.node.kind === "symbol").map((s) => kindName(s.node)),
    ).toEqual(["Function", "Class", "Method", "Variable"]);
    expect(kindName(sample("external"))).toBe("External API");
  });

  it("splits a route's method off its path, and draws code-like names as code", () => {
    expect(nodeLabel(sample("route"))).toEqual({ method: "POST", code: "/api/orders" });
    expect(nodeLabel(sample("symbol"))).toEqual({ code: "createOrder" });
    expect(nodeLabel(sample("page"))).toEqual({ code: "/checkout" });
    expect(nodeLabel(sample("unresolved"))).toEqual({ code: "fetch(`${CMS_URL}/posts`)" });
    expect(nodeLabel(sample("service"))).toEqual({ text: "web" });
  });

  it.each([
    ["service", { text: "Next.js", code: "apps/web" }],
    ["module", { code: "apps/api/src/routes" }],
    ["file", { code: "apps/api/src/routes" }],
    ["symbol", { text: "Exported function" }],
    ["route", {}],
    ["page", { text: "Page" }],
    ["model", { text: "6 fields" }],
    ["datastore", { text: "PostgreSQL" }],
    ["queue", { text: "Redis queue" }],
    ["external", { text: "Stripe" }],
    ["unresolved", { text: "URL built from CMS_URL at runtime" }],
  ] as const)("subtitles a %s from its own fields", (kind, expected) => {
    expect(nodeSubtitle(sample(kind))).toEqual(expected);
  });

  it("falls back to plain names when nothing more is known", () => {
    const svc = { ...base, id: "s", kind: "service", root: "" } as const;
    expect(nodeSubtitle(svc)).toEqual({ text: "Service" });
    expect(nodeSubtitle({ ...svc, framework: "remix" })).toEqual({ text: "remix" });
    expect(nodeSubtitle({ ...svc, root: "apps/x" })).toEqual({ code: "apps/x" });
    expect(nodeSubtitle({ ...base, id: "m", kind: "module", path: "" })).toEqual({});
    expect(
      nodeSubtitle({ ...base, id: "f", kind: "file", path: "index.ts", hash: "0".repeat(64) }),
    ).toEqual({});
    expect(
      nodeSubtitle({ ...base, id: "y", kind: "symbol", symbolKind: "method", exported: false }),
    ).toEqual({ text: "Method" });
    expect(nodeSubtitle({ ...base, id: "md", kind: "model", fields: [] })).toEqual({
      text: "No fields",
    });
    expect(
      nodeSubtitle({
        ...base,
        id: "md",
        kind: "model",
        fields: [{ name: "id", type: "Int", optional: false }],
      }),
    ).toEqual({ text: "1 field" });
    expect(nodeSubtitle({ ...base, id: "d", kind: "datastore", engine: "sqlserver" })).toEqual({
      text: "sqlserver",
    });
    expect(nodeSubtitle({ ...base, id: "e", kind: "external", host: "cms.example.com" })).toEqual({
      text: "External API",
      code: "cms.example.com",
    });
    expect(nodeSubtitle({ ...base, id: "system:root", kind: "system", parentId: null })).toEqual({
      text: "System",
    });
  });

  it.each(UnresolvedReason.options)("explains %s in words when there is no detail", (reason) => {
    const node = { ...base, id: "u", kind: "unresolved", reason, expression: "x" } as const;
    // Sentence case, no trailing period, and never the raw code.
    expect(REASON_TEXT[reason]).toMatch(/^[A-Z].* [a-z]+[a-z]$/);
    expect(REASON_TEXT[reason]).not.toContain("_");
    expect(nodeSubtitle(node)).toEqual({ text: REASON_TEXT[reason] });
  });

  it("names a node and its active states for screen readers", () => {
    const route = sample("route");
    expect(nodeAccessibleName(route)).toBe("POST /api/orders, route");
    expect(nodeAccessibleName(route, { selected: true, emphasis: "traced" })).toBe(
      "POST /api/orders, route. Selected. On the request path",
    );
    expect(nodeAccessibleName(sample("module"), { diff: "removed", emphasis: "dimmed" })).toBe(
      "routes, module. Removed in this change",
    );
  });

  it("counts with the right noun", () => {
    expect(countText({ value: 1, noun: "route" })).toBe("1 route");
    expect(countText({ value: 1204, noun: "file" })).toBe("1,204 files");
    expect(countText({ value: 2, noun: "query", plural: "queries" })).toBe("2 queries");
  });
});

describe("DiagramNode", () => {
  it("draws a card with its icon, name, subtitle, and counts", () => {
    const { getByRole } = render(
      <DiagramNode node={sample("route")} counts={[{ value: 2, noun: "caller" }]} />,
    );
    const el = getByRole("group", { name: "POST /api/orders, route" });
    expect(el.dataset).toMatchObject({ tier: "card", kind: "route", layer: "backend" });
    expect(el.querySelector(".gi-method")?.textContent).toBe("POST");
    expect(el.querySelector(".gi-node__label code")?.textContent).toBe("/api/orders");
    expect(el.querySelector("[data-glyph='route']")).not.toBeNull();
    expect(el.querySelector(".gi-node__subtitle")).toBeNull();
    expect(el.querySelector(".gi-badge")?.textContent).toBe("2 callers");
    expect(el.querySelector(".gi-icon-tile")?.getAttribute("data-size")).toBe("sm");
  });

  it("draws icon-first nodes on a large tile with their logo", () => {
    const { getByRole } = render(<DiagramNode node={sample("datastore")} />);
    const el = getByRole("group", { name: "postgres, datastore" });
    expect(el.dataset["tier"]).toBe("icon");
    expect(el.querySelector(".gi-icon-tile")?.getAttribute("data-size")).toBe("lg");
    expect(el.querySelector("[data-brand='postgresql']")).not.toBeNull();
    expect(el.querySelector(".gi-node__subtitle")?.textContent).toBe("PostgreSQL");
  });

  it.each([
    ["datastore", "cylinder", 56],
    ["queue", "pipe", 84],
    ["external", "circle", 64],
  ] as const)("draws a %s's tile as a %s outline", (kind, shape, width) => {
    const { getByRole } = render(<DiagramNode node={sample(kind)} />);
    const el = getByRole("group");
    expect(el.dataset["shape"]).toBe(shape);
    const tile = el.querySelector<HTMLElement>(".gi-icon-tile");
    expect(tile?.dataset["shape"]).toBe(shape);
    expect(tile?.style.width).toBe(`${width}px`);
    expect(tile?.style.height).toBe("64px");
    const outline = tile?.querySelector("svg.gi-icon-tile__outline");
    expect(outline?.getAttribute("aria-hidden")).toBe("true");
    expect(outline?.querySelector("path")?.getAttribute("d")).toBe(TILE_OUTLINES[shape].d);
    // The icon is still there, on top of the outline.
    expect(tile?.lastElementChild?.matches(".gi-brand, .gi-glyph")).toBe(true);
  });

  it("keeps the rounded square for small tiles, whatever the node", () => {
    const { container } = render(
      <IconTile size="sm" shape="cylinder">
        <span />
      </IconTile>,
    );
    const tile = container.querySelector<HTMLElement>(".gi-icon-tile");
    expect(tile?.dataset["shape"]).toBeUndefined();
    expect(tile?.querySelector("svg")).toBeNull();
  });

  it("moves the icon to the outline's icon point", () => {
    for (const shape of Object.keys(TILE_OUTLINES) as (keyof typeof TILE_OUTLINES)[]) {
      const o = TILE_OUTLINES[shape];
      const { container } = render(
        <IconTile size="lg" shape={shape}>
          <span />
        </IconTile>,
      );
      const style = container.querySelector<HTMLElement>(".gi-icon-tile")?.style;
      const left = parseFloat(style?.paddingLeft || "0") - parseFloat(style?.paddingRight || "0");
      const top = parseFloat(style?.paddingTop || "0") - parseFloat(style?.paddingBottom || "0");
      // A centered child of the padded box sits at (width + left) / 2, (height + top) / 2.
      expect((o.width + left) / 2).toBe(o.iconX);
      expect((o.height + top) / 2).toBe(o.iconY);
      cleanup();
    }
  });

  it("draws a model as a table, its fields on a row of their own", () => {
    const { getByRole } = render(<DiagramNode node={sample("model")} />);
    const el = getByRole("group", { name: "Order, model" });
    expect(el.dataset["shape"]).toBe("table");
    const fields = el.querySelector(".gi-node__fields");
    expect(fields?.tagName).toBe("CODE");
    expect(fields?.textContent).toBe("id · total · status · userId · note? · createdAt");
    expect(fields?.getAttribute("title")).toBe(fields?.textContent);
    // Other kinds have no fields row.
    cleanup();
    const { getByRole: get } = render(<DiagramNode node={sample("route")} />);
    expect(get("group").dataset["shape"]).toBe("capsule");
    expect(get("group").querySelector(".gi-node__fields")).toBeNull();
  });

  it("inherits the service's layer only when the node has none", () => {
    const { getByRole, rerender } = render(<DiagramNode node={sample("file")} layer="backend" />);
    expect(getByRole("group").dataset["layer"]).toBe("backend");
    expect(getByRole("group").querySelector(".gi-icon-tile")?.getAttribute("data-layer")).toBe(
      "backend",
    );
    rerender(<DiagramNode node={sample("route")} layer="frontend" />);
    expect(getByRole("group").dataset["layer"]).toBe("backend");
    rerender(<DiagramNode node={sample("file")} />);
    expect(getByRole("group").dataset["layer"]).toBeUndefined();
  });

  it("sets each state as a data attribute, so states combine", () => {
    const { getByRole } = render(
      <DiagramNode node={sample("symbol")} hovered selected emphasis="traced" diff="changed" />,
    );
    const el = getByRole("group");
    expect(el.dataset).toMatchObject({
      hover: "",
      selected: "",
      emphasis: "traced",
      diff: "changed",
    });
    expect(el.getAttribute("aria-label")).toBe(
      "createOrder, function. Selected. On the request path. Changed in this change",
    );
  });

  it("sets no state attributes by default", () => {
    const { getByRole } = render(<DiagramNode node={sample("symbol")} />);
    const el = getByRole("group");
    for (const a of [
      "data-hover",
      "data-selected",
      "data-emphasis",
      "data-diff",
      "data-expanded",
    ]) {
      expect(el.hasAttribute(a)).toBe(false);
    }
    expect(el.querySelector(".gi-node__badges")).toBeNull();
  });

  it("names the diff state on a badge, so color is never the only signal", () => {
    for (const [diff, word] of [
      ["added", "Added"],
      ["changed", "Changed"],
      ["removed", "Removed"],
    ] as const) {
      const { getByRole, unmount } = render(<DiagramNode node={sample("model")} diff={diff} />);
      const badge = getByRole("group").querySelector(`.gi-badge[data-diff='${diff}']`);
      expect(badge?.textContent).toBe(word);
      unmount();
    }
  });

  it("keeps the diff tag out of the count row, so it never squeezes the name", () => {
    const { getByRole } = render(
      <DiagramNode node={sample("symbol")} diff="added" counts={[{ value: 3, noun: "caller" }]} />,
    );
    const el = getByRole("group");
    expect(el.querySelector(".gi-node__badges")?.textContent).toBe("3 callers");
    expect(el.querySelector(":scope > .gi-node__diff")?.textContent).toBe("Added");
  });

  it("marks counts of unresolved items for the dotted style", () => {
    const { getByRole } = render(
      <DiagramNode node={sample("service")} counts={sampleOf("service").counts!} />,
    );
    const badges = [...getByRole("group").querySelectorAll(".gi-badge")];
    expect(badges.map((b) => [b.textContent, b.hasAttribute("data-unresolved")])).toEqual([
      ["14 pages", false],
      ["2 unresolved calls", true],
    ]);
  });

  it("draws a closed frame as one element and an open one around its children", () => {
    const { getByRole, rerender } = render(
      <DiagramNode node={sample("service")}>
        <span>inside</span>
      </DiagramNode>,
    );
    const closed = getByRole("group");
    expect(closed.dataset["expanded"]).toBe("false");
    expect(closed.textContent).not.toContain("inside");

    rerender(
      <DiagramNode node={sample("service")} expanded>
        <span>inside</span>
      </DiagramNode>,
    );
    const open = getByRole("group");
    expect(open.tagName).toBe("SECTION");
    expect(open.dataset["expanded"]).toBe("true");
    expect(open.querySelector(".gi-node__header [data-brand='nextdotjs']")).not.toBeNull();
    expect(open.querySelector(".gi-node__body")?.textContent).toBe("inside");
  });

  it("ignores expanded on kinds that aren't frames", () => {
    const { getByRole } = render(<DiagramNode node={sample("file")} expanded />);
    expect(getByRole("group").tagName).toBe("DIV");
    expect(getByRole("group").hasAttribute("data-expanded")).toBe(false);
  });

  it("passes extra attributes and classes to the root", () => {
    let clicked = 0;
    const { getByRole } = render(
      <DiagramNode
        node={sample("page")}
        className="extra"
        tabIndex={0}
        onClick={() => clicked++}
      />,
    );
    const el = getByRole("group");
    expect(el.className).toBe("gi-node extra");
    expect(el.tabIndex).toBe(0);
    el.click();
    expect(clicked).toBe(1);
  });
});

describe("Nodes stories", () => {
  const { Kinds, States, Frames } = composeStories(stories);

  it("show every node kind except the never-drawn system root", () => {
    const { container } = render(<Kinds />);
    const kinds = new Set(
      [...container.querySelectorAll(".gi-node")].map((e) => e.getAttribute("data-kind")),
    );
    expect([...kinds].sort()).toEqual(NodeKind.options.filter((k) => k !== "system").sort());
  });

  it("show every sample in every state", () => {
    const { container } = render(<States />);
    const nodes = container.querySelectorAll(".gi-node");
    expect(nodes).toHaveLength(nodeSamples.length * nodeStates.length);
    for (const attr of ["data-hover", "data-selected"]) {
      expect(container.querySelectorAll(`[${attr}]`)).toHaveLength(nodeSamples.length);
    }
    for (const value of ["dimmed", "traced"]) {
      expect(container.querySelectorAll(`[data-emphasis='${value}']`)).toHaveLength(
        nodeSamples.length,
      );
    }
    for (const value of ["added", "changed", "removed"]) {
      expect(container.querySelectorAll(`.gi-node[data-diff='${value}']`)).toHaveLength(
        nodeSamples.length,
      );
    }
  });

  it("show frames open in place, nested", () => {
    const { container } = render(<Frames />);
    const open = container.querySelectorAll("[data-expanded='true']");
    expect([...open].map((e) => e.getAttribute("data-kind"))).toEqual(["service", "module"]);
    expect(open[0]!.contains(open[1]!)).toBe(true);
    expect(container.querySelectorAll("[data-expanded='false']")).toHaveLength(2);
  });
});
