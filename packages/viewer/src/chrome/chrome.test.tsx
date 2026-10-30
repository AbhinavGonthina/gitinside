import { compareStrings, Confidence, Layer } from "@gitinside/schema";
import { composeStories } from "@storybook/react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio } from "../contrast.js";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import { DIFF_TEXT, nodeShape } from "../nodes/describe.js";
import { nodeSamples, sampleOf } from "../nodes/samples.js";
import { themeTokens } from "../tokens.js";
import * as stories from "./Chrome.stories.js";
import { CommandPalette } from "./CommandPalette.js";
import { Button, IconButton, SegmentedControl, StatusChip, Toggle } from "./controls.js";
import {
  boundsOf,
  githubLineUrl,
  highlightSegments,
  LAYER_NAMES,
  minimapFit,
  shortSha,
  toMinimap,
  zoomText,
} from "./describe.js";
import { CodePreview, ConnectionList, FactList, InspectorHeader } from "./Inspector.js";
import { Breadcrumbs, Legend, Minimap, SHAPE_TEXT, ZoomControls } from "./overlays.js";
import { minimapNodes, paletteResults, sampleCrumbs, sampleRepo } from "./samples.js";
import { DIFF_VIEWS, TopBar } from "./TopBar.js";
import { UI_ICON_STROKE, UiIcon, uiIconNames } from "./uiIcons.js";

afterEach(cleanup);

describe("chrome words", () => {
  it("names every layer, in the schema's order", () => {
    expect(Object.keys(LAYER_NAMES)).toEqual(Layer.options);
  });

  it("lists confidences and diff states in the order the legend shows them", () => {
    expect(Object.keys(CONFIDENCE_TEXT)).toEqual(Confidence.options);
    expect(Object.keys(DIFF_TEXT)).toEqual(["added", "changed", "removed"]);
  });

  it("shortens a SHA to 7 characters", () => {
    expect(shortSha(sampleRepo.sha as string)).toBe("a1b2c3f");
  });

  it("shows zoom as a whole percentage", () => {
    expect(zoomText(0.754)).toBe("75%");
    expect(zoomText(1)).toBe("100%");
    expect(zoomText(2.5)).toBe("250%");
  });
});

describe("githubLineUrl", () => {
  it("links the file at the analyzed commit and line", () => {
    expect(githubLineUrl(sampleRepo, "apps/api/src/routes/orders.ts", 14)).toBe(
      `https://github.com/acme/shop/blob/${sampleRepo.sha}/apps/api/src/routes/orders.ts#L14`,
    );
  });

  it("encodes each path segment but keeps the slashes", () => {
    expect(githubLineUrl(sampleRepo, "docs/my file#1.ts")).toBe(
      `https://github.com/acme/shop/blob/${sampleRepo.sha}/docs/my%20file%231.ts`,
    );
  });

  it("gives no link without a SHA, rather than a branch that may have moved", () => {
    expect(githubLineUrl({ owner: "acme", name: "shop" }, "a.ts", 1)).toBeUndefined();
  });
});

describe("minimap geometry", () => {
  it("fits the content inside the padding, centered on the short axis", () => {
    const content = { x: 0, y: 0, width: 400, height: 200 };
    const fit = minimapFit(content, { width: 200, height: 128 });
    expect(fit).toEqual({ scale: 0.46, dx: 8, dy: 18 });
    expect(toMinimap(content, fit)).toEqual({ x: 8, y: 18, width: 184, height: 92 });
  });

  it("moves content that starts away from the origin into the box", () => {
    const content = { x: -100, y: 50, width: 400, height: 200 };
    const r = toMinimap(content, minimapFit(content, { width: 200, height: 128 }));
    expect(r).toEqual({ x: 8, y: 18, width: 184, height: 92 });
  });

  it("keeps a zero-size diagram finite", () => {
    const fit = minimapFit({ x: 5, y: 5, width: 0, height: 0 }, { width: 200, height: 128 });
    expect(Number.isFinite(fit.scale) && Number.isFinite(fit.dx)).toBe(true);
  });

  it("bounds every box, or nothing for no boxes", () => {
    expect(boundsOf([])).toBeUndefined();
    expect(
      boundsOf([
        { x: 10, y: 20, width: 10, height: 10 },
        { x: -5, y: 0, width: 5, height: 50 },
      ]),
    ).toEqual({ x: -5, y: 0, width: 25, height: 50 });
  });
});

describe("highlightSegments", () => {
  it("returns the whole text unmatched without ranges, and nothing for no text", () => {
    expect(highlightSegments("orders.ts")).toEqual([{ text: "orders.ts", match: false }]);
    expect(highlightSegments("", [[0, 2]])).toEqual([]);
  });

  it("alternates matched and unmatched runs", () => {
    expect(highlightSegments("createOrder", [[6, 9]])).toEqual([
      { text: "create", match: false },
      { text: "Ord", match: true },
      { text: "er", match: false },
    ]);
  });

  it("sorts, clamps, and merges overlapping or touching ranges", () => {
    expect(
      highlightSegments("abcdefgh", [
        [6, 99],
        [2, 4],
        [-3, 1],
        [3, 5],
        [5, 5],
      ]),
    ).toEqual([
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "cde", match: true },
      { text: "f", match: false },
      { text: "gh", match: true },
    ]);
  });
});

describe("controls", () => {
  it("renders a plain button that never submits a form", () => {
    render(
      <Button icon="trace" shortcut={["T"]}>
        Trace a request
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Trace a request" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.variant).toBe("secondary");
    expect(button.querySelector(".gi-kbd-group")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("names an icon-only button for screen readers and the tooltip", () => {
    render(<IconButton icon="close" label="Close legend" />);
    const button = screen.getByRole("button", { name: "Close legend" });
    expect(button.getAttribute("title")).toBe("Close legend");
    expect(button.dataset.variant).toBe("quiet");
    expect(button.hasAttribute("data-icon-only")).toBe(true);
  });

  it("toggles a switch through its callback", () => {
    const onChange = vi.fn();
    render(
      <Toggle checked={false} onChange={onChange}>
        Hide tests and config
      </Toggle>,
    );
    const toggle = screen.getByRole("switch", { name: "Hide tests and config" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is one tab stop as a segmented control, and arrow keys move the choice with wrap", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Diff view"
        options={DIFF_VIEWS}
        value="overlay"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Diff view" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios[2] as HTMLElement, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("base");
    fireEvent.keyDown(radios[2] as HTMLElement, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("head");
    fireEvent.keyDown(radios[2] as HTMLElement, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.click(radios[0] as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith("base");
  });

  it("gives a status chip a named exit button, and a diff chip the compare icon", () => {
    const onExit = vi.fn();
    const { container } = render(
      <>
        <StatusChip tone="trace" exitLabel="Exit trace" onExit={onExit}>
          Tracing /checkout
        </StatusChip>
        <StatusChip tone="diff">Comparing main → PR #12</StatusChip>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Exit trace" }));
    expect(onExit).toHaveBeenCalledOnce();
    const [trace, diff] = container.querySelectorAll(".gi-status");
    expect(trace?.querySelector(".gi-status__dot")).not.toBeNull();
    expect(diff?.querySelector('[data-icon="compare"]')).not.toBeNull();
    expect(diff?.querySelector(".gi-status__dot")).toBeNull();
  });

  it("draws every interface icon as one stroke family, painted only by the svg", () => {
    for (const name of uiIconNames) {
      const { container, unmount } = render(<UiIcon name={name} />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke-width")).toBe(String(UI_ICON_STROKE));
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      for (const el of svg.querySelectorAll("*")) {
        expect(el.getAttribute("fill")).toBeNull();
        expect(el.getAttribute("stroke")).toBeNull();
      }
      unmount();
    }
  });
});

describe("TopBar", () => {
  it("shows the repo and the short commit, with the full SHA in the tooltip", () => {
    const { container } = render(<TopBar repo={sampleRepo} branch="main" />);
    expect(container.querySelector(".gi-repo__name")?.textContent).toBe("acme / shop");
    const chip = container.querySelector(".gi-chip") as HTMLElement;
    expect(chip.textContent).toBe("maina1b2c3f");
    expect(chip.title).toBe(`Commit ${sampleRepo.sha}`);
  });

  it("leaves out the commit chip when there is neither branch nor SHA", () => {
    const { container } = render(<TopBar repo={{ owner: "acme", name: "shop" }} />);
    expect(container.querySelector(".gi-chip")).toBeNull();
  });

  it("opens search from the field, with the platform's shortcut", () => {
    const onSearch = vi.fn();
    const { rerender } = render(<TopBar repo={sampleRepo} onSearch={onSearch} />);
    const field = screen.getByRole("button", { name: /Search services, files, routes/ });
    expect(field.textContent).toContain("CtrlK");
    expect(field.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    fireEvent.click(field);
    expect(onSearch).toHaveBeenCalledOnce();
    rerender(<TopBar repo={sampleRepo} mac />);
    expect(screen.getByRole("button", { name: /Search/ }).textContent).toContain("⌘K");
  });

  it("shows the diff view only when there is a base, and counts active filters", () => {
    const { rerender } = render(<TopBar repo={sampleRepo} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    rerender(<TopBar repo={sampleRepo} diff={{ value: "head" }} filterCount={2} />);
    expect(screen.getByRole("radio", { name: "Head" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Filters 2" })).toBeTruthy();
  });

  it("makes Trace the one primary action, and Exit trace while tracing", () => {
    const onTrace = vi.fn();
    const { container, rerender } = render(<TopBar repo={sampleRepo} onTrace={onTrace} />);
    const trace = screen.getByRole("button", { name: /Trace a request/ });
    expect(trace.dataset.variant).toBe("primary");
    expect(trace.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    fireEvent.click(trace);
    expect(onTrace).toHaveBeenCalledOnce();
    rerender(<TopBar repo={sampleRepo} tracing />);
    const exit = screen.getByRole("button", { name: /Exit trace/ });
    expect(exit.dataset.variant).toBe("secondary");
  });
});

describe("canvas overlays", () => {
  it("marks the current level and lets every level above it be chosen", () => {
    const onSelect = vi.fn();
    render(<Breadcrumbs items={sampleCrumbs} onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "Drill-down path" });
    const current = nav.querySelector('[aria-current="location"]') as HTMLElement;
    expect(current.textContent).toBe("orders.ts");
    expect(current.querySelector("code")).not.toBeNull();
    const links = within(nav).getAllByRole("button");
    expect(links.map((b) => b.textContent)).toEqual(["shop", "api", "routes"]);
    fireEvent.click(links[1] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("service:api");
  });

  it("names each zoom control and shows the level", () => {
    const calls = { onZoomIn: vi.fn(), onZoomOut: vi.fn(), onFit: vi.fn() };
    render(<ZoomControls zoom={0.75} {...calls} />);
    const group = screen.getByRole("group", { name: "Zoom" });
    expect(group.querySelector("output")?.textContent).toBe("75%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(calls.onZoomIn).toHaveBeenCalledOnce();
    expect(calls.onZoomOut).toHaveBeenCalledOnce();
    expect(calls.onFit).toHaveBeenCalledOnce();
  });

  it("draws each box by layer, plus a viewport frame that stays inside the map", () => {
    const { container } = render(
      <Minimap nodes={minimapNodes} viewport={{ x: 2000, y: 2000, width: 400, height: 300 }} />,
    );
    const boxes = container.querySelectorAll(".gi-minimap__node");
    expect(boxes).toHaveLength(minimapNodes.length);
    expect(boxes[0]?.getAttribute("data-layer")).toBe("frontend");
    const view = container.querySelector(".gi-minimap__viewport") as SVGRectElement;
    const n = (a: string) => Number(view.getAttribute(a));
    expect(n("x")).toBeGreaterThanOrEqual(0);
    expect(n("x") + n("width")).toBeLessThanOrEqual(200);
    expect(n("y") + n("height")).toBeLessThanOrEqual(128);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Minimap of 6 boxes/);
  });

  it("explains every layer, confidence line style, and diff state in the legend", () => {
    const onClose = vi.fn();
    const { container } = render(<Legend onClose={onClose} />);
    const text = container.textContent ?? "";
    for (const name of Object.values(LAYER_NAMES)) expect(text).toContain(name);
    for (const words of Object.values(CONFIDENCE_TEXT)) expect(text).toContain(words);
    for (const words of Object.values(DIFF_TEXT)) expect(text).toContain(`${words} in this change`);
    const lines = [...container.querySelectorAll(".gi-edge")].map((e) =>
      e.getAttribute("data-line"),
    );
    expect(lines).toEqual(["solid", "dot", "dashed", "dotted"]);
    fireEvent.click(screen.getByRole("button", { name: "Close legend" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("draws and names every shape the canvas uses, with the stacked edge (design gate)", () => {
    const { container } = render(<Legend />);
    const text = container.textContent ?? "";
    const used = new Set(nodeSamples.map((s) => nodeShape(s.node, s.layer)));
    for (const shape of used) expect(text).toContain(SHAPE_TEXT[shape]);
    expect(Object.keys(SHAPE_TEXT).sort(compareStrings)).toEqual([...used].sort(compareStrings));
    expect(text).toContain("Stacked edge: opens in place");
    expect(container.querySelectorAll(".gi-legend__shape")).toHaveLength(used.size + 1);
  });
});

describe("inspector", () => {
  it("heads with kind and inherited layer chips and the node's name", () => {
    const { container } = render(
      <InspectorHeader node={sampleOf("symbol").node} layer="backend" location="a.ts:3" />,
    );
    const chips = [...container.querySelectorAll(".gi-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Function", "Backend"]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("createOrder");
    expect(container.querySelector(".gi-inspector__subtitle")?.textContent).toBe(
      "Exported function",
    );
  });

  it("puts a route's method in its chip, and leaves an unresolved reason to the summary", () => {
    render(<InspectorHeader node={sampleOf("route").node} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.querySelector(".gi-method")?.textContent).toBe("POST");
    cleanup();
    const { container } = render(<InspectorHeader node={sampleOf("unresolved").node} />);
    expect(container.querySelector(".gi-inspector__subtitle")).toBeNull();
    expect(container.querySelectorAll(".gi-chip")).toHaveLength(1);
  });

  it("lists connections with the edge's words and line style, and selects on click", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ConnectionList
        empty="None"
        onSelect={onSelect}
        items={[
          {
            node: sampleOf("model").node,
            edge: { kind: "writes", confidence: "pattern", fields: ["total"] },
          },
        ]}
      />,
    );
    const row = screen.getByRole("button", { name: /Order/ });
    expect(row.textContent).toContain("writes total · Pattern match");
    const line = container.querySelector(".gi-connection__line") as SVGElement;
    expect(line.getAttribute("data-line")).toBe("dot");
    expect(line.querySelector("circle")).not.toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("model:db/schema.prisma#Order");
  });

  it("puts code facts in mono and every whole value in its tooltip", () => {
    const { container } = render(
      <FactList
        facts={[
          { label: "Pages", value: "14" },
          { label: "File", value: "apps/api/src/routes/orders.ts", code: true },
        ]}
      />,
    );
    const values = container.querySelectorAll("dd");
    expect(values[0]?.querySelector("code")).toBeNull();
    expect(values[1]?.querySelector("code")?.textContent).toBe("apps/api/src/routes/orders.ts");
    expect(values[1]?.getAttribute("title")).toBe("apps/api/src/routes/orders.ts");
  });

  it("says so when there are no connections", () => {
    render(<ConnectionList items={[]} empty="Nothing in the repo calls this." />);
    expect(screen.getByText("Nothing in the repo calls this.")).toBeTruthy();
  });

  it("numbers code lines, marks the selection's line, and links it on GitHub", () => {
    const { container } = render(
      <CodePreview
        path="a.ts"
        startLine={7}
        lines={["one", "", "three"]}
        highlight={8}
        href="https://github.com/acme/shop/blob/abc1234/a.ts#L8"
      />,
    );
    const lines = container.querySelectorAll(".gi-code__line");
    expect([...lines].map((l) => l.querySelector(".gi-code__number")?.textContent)).toEqual([
      "7",
      "8",
      "9",
    ]);
    expect(lines[1]?.hasAttribute("data-highlight")).toBe(true);
    expect(lines[0]?.hasAttribute("data-highlight")).toBe(false);
    expect(lines[1]?.querySelector("code")?.textContent).toBe(" ");
    // The code sample's path is the link to the file and line (design gate).
    const link = screen.getByRole("link", { name: "a.ts" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/shop/blob/abc1234/a.ts#L8");
    expect(link.getAttribute("title")).toBe("Open a.ts at line 8 on GitHub");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows plain text first, then the same text colored as React spans", async () => {
    const lines = [
      " * The page. */",
      'const page = "<script>alert(1)</script>";',
      "",
      "export default page;",
    ];
    // JSX: no other test in this file loads that grammar, so it starts pending.
    const { container } = render(
      <CodePreview path="a.jsx" startLine={2} lines={lines} before={["/**"]} />,
    );
    const figure = screen.getByRole("figure");
    const texts = () =>
      [...container.querySelectorAll(".gi-code__line code")].map((c) => c.textContent);
    const plain = [lines[0], lines[1], " ", lines[3]];
    expect(figure.getAttribute("data-syntax")).toBe("pending");
    expect(container.querySelector("[data-token]")).toBeNull();
    expect(texts()).toEqual(plain);

    await waitFor(() => expect(figure.getAttribute("data-syntax")).toBe("done"));
    expect(texts()).toEqual(plain);
    // The context line opened a doc comment, so the first line is all comment.
    const first = container.querySelectorAll(".gi-code__line code")[0]!;
    expect([...first.childNodes].map((s) => (s as Element).getAttribute("data-token"))).toEqual([
      "comment",
    ]);
    const tokens = [...container.querySelectorAll("[data-token]")];
    const pairs = tokens.map((t) => [t.textContent, t.getAttribute("data-token")]);
    expect(pairs).toContainEqual(["const", "keyword"]);
    expect(pairs).toContainEqual(['"<script>alert(1)</script>"', "string"]);
    // Tokens are text in spans, never markup (SECURITY.md T10).
    expect(container.querySelector("script")).toBeNull();
    expect(tokens.every((t) => t.tagName === "SPAN" && t.children.length === 0)).toBe(true);
  });

  it("leaves a language it doesn't color plain", () => {
    const { container } = render(
      <CodePreview path="Dockerfile" startLine={1} lines={["FROM node"]} />,
    );
    expect(screen.getByRole("figure").getAttribute("data-syntax")).toBe("plain");
    expect(container.querySelector(".gi-code__line code")?.textContent).toBe("FROM node");
  });

  it("has no GitHub link without a permalink", () => {
    render(<CodePreview path="a.ts" startLine={1} lines={["x"]} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps its frame and link while loading, and says when the file couldn't load", () => {
    const href = "https://github.com/acme/shop/blob/abc1234/a.ts#L3";
    const { container, rerender } = render(
      <CodePreview path="a.ts" startLine={3} lines={["ignored"]} href={href} status="loading" />,
    );
    expect(screen.getByRole("figure").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading the code");
    expect(container.querySelector(".gi-code__line")).toBeNull();
    expect(screen.getByRole("link", { name: "a.ts" }).getAttribute("href")).toBe(href);

    rerender(<CodePreview path="a.ts" startLine={3} lines={[]} href={href} status="failed" />);
    expect(screen.getByRole("figure").hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Couldn't load this file.");
    expect(screen.getByRole("link", { name: "a.ts" })).toBeTruthy();
  });
});

describe("CommandPalette", () => {
  it("is a modal dialog whose field points at the active result", () => {
    render(<CommandPalette query="ord" results={paletteResults} activeIndex={1} />);
    expect(
      screen.getByRole("dialog", { name: "Search the diagram" }).getAttribute("aria-modal"),
    ).toBe("true");
    const field = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(paletteResults.length);
    expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(field.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("while closing, plays its exit out of reach of the pointer and screen readers (M4b.0e)", () => {
    const { container, rerender } = render(<CommandPalette query="" results={[]} />);
    const scrim = container.querySelector(".gi-palette-scrim") as HTMLElement;
    expect(scrim.dataset.state).toBe("open");
    expect(scrim.hasAttribute("inert")).toBe(false);
    rerender(<CommandPalette query="" results={[]} state="closing" />);
    expect(scrim.dataset.state).toBe("closing");
    expect(scrim.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the matched characters and draws code-like names in mono", () => {
    render(<CommandPalette query="ord" results={paletteResults} />);
    const route = screen.getAllByRole("option")[0] as HTMLElement;
    expect(route.querySelector("mark")?.textContent).toBe("ord");
    expect(route.querySelector(".gi-palette__name")?.tagName).toBe("CODE");
    expect(route.querySelector(".gi-palette__kind")?.textContent).toBe("Route");
    const model = screen.getAllByRole("option")[3] as HTMLElement;
    expect(model.querySelector(".gi-palette__name")?.tagName).toBe("SPAN");
  });

  it("moves with the arrow keys (wrapping), opens with Enter, and closes with Esc", () => {
    const handlers = { onActiveIndexChange: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    render(<CommandPalette query="ord" results={paletteResults} activeIndex={0} {...handlers} />);
    const field = screen.getByRole("combobox");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(handlers.onActiveIndexChange).toHaveBeenLastCalledWith(paletteResults.length - 1);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(handlers.onActiveIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(handlers.onPick).toHaveBeenCalledWith("route:api/POST /api/orders");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("reports typing, picks on click, and closes on the scrim but not inside the dialog", () => {
    const handlers = { onQueryChange: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const { container } = render(
      <CommandPalette query="ord" results={paletteResults} {...handlers} />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "orde" } });
    expect(handlers.onQueryChange).toHaveBeenCalledWith("orde");
    fireEvent.click(screen.getAllByRole("option")[2] as HTMLElement);
    expect(handlers.onPick).toHaveBeenCalledWith(paletteResults[2]?.node.id);
    expect(handlers.onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".gi-palette-scrim") as HTMLElement);
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("clamps the active index, and says what to try when nothing matches", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <CommandPalette query="ord" results={paletteResults} activeIndex={99} onPick={onPick} />,
    );
    expect(screen.getAllByRole("option").at(-1)?.getAttribute("aria-selected")).toBe("true");
    rerender(<CommandPalette query="cms" results={[]} onPick={onPick} />);
    const field = screen.getByRole("combobox");
    expect(field.getAttribute("aria-activedescendant")).toBeNull();
    expect(field.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Nothing matches “cms”");
    rerender(<CommandPalette query="" results={[]} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Type to search/);
  });
});

describe("contrast of chrome-only pairings", () => {
  it.each(["dark", "light"] as const)("keeps primary button text at 4.5:1 in %s", (theme) => {
    const t = themeTokens[theme];
    expect(contrastRatio(t.canvas, t.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["dark", "light"] as const)("keeps both switch thumbs at 3:1 in %s", (theme) => {
    const t = themeTokens[theme];
    expect(contrastRatio(t.canvas, t.accent)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t["text-muted"], t["surface-2"])).toBeGreaterThanOrEqual(3);
  });
});

describe("chrome stories", () => {
  const all = composeStories(stories);

  it("show every button variant and every interface icon", () => {
    const { container } = render(<all.Controls />);
    const variants = new Set(
      [...container.querySelectorAll(".gi-button")].map((b) => b.getAttribute("data-variant")),
    );
    expect([...variants].sort()).toEqual(["primary", "quiet", "secondary"]);
    const icons = new Set(
      [...container.querySelectorAll("[data-icon]")].map((e) => e.getAttribute("data-icon")),
    );
    for (const name of uiIconNames) expect(icons.has(name)).toBe(true);
  });

  it("show the top bar plain, in a pull request, and tracing", () => {
    const { container } = render(<all.TopBars />);
    expect(container.querySelectorAll(".gi-topbar")).toHaveLength(3);
    expect(screen.getAllByRole("radiogroup")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Exit trace/ })).toHaveLength(1);
  });

  it("show three inspectors, and the legend toggles from its button", () => {
    render(<all.Inspectors />);
    expect(screen.getAllByRole("complementary", { name: "Inspector" })).toHaveLength(3);
    cleanup();
    render(<all.Overlays />);
    expect(screen.getByRole("region", { name: "Legend" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Legend" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "Legend" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("show the palette with results that follow the keyboard, and with none", () => {
    render(<all.Palette />);
    const field = screen.getByRole("combobox");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    cleanup();
    render(<all.PaletteEmpty />);
    expect(screen.getByRole("status").textContent).toContain("cms webhook");
  });

  it("show the whole layout: top bar, canvas overlays, diagram, and inspector", () => {
    const { container } = render(<all.Layout />);
    for (const cls of ["gi-topbar", "gi-zoom", "gi-breadcrumbs", "gi-minimap", "gi-inspector"]) {
      expect(container.querySelectorAll(`.${cls}`)).toHaveLength(1);
    }
    expect(container.querySelectorAll(".gi-node").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".gi-edge").length).toBeGreaterThan(0);
  });
});
