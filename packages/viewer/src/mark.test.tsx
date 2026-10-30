import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogoMark } from "./chrome/uiIcons.js";
import { contrastRatio } from "./contrast.js";
import { renderBadge } from "./image/badge.js";
import { renderDiagram } from "./image/diagram.js";
import { MARK_NODE, MARK_PATH, markMarkup, markStroke } from "./mark.js";
import { shopDemo } from "./shopDemo.testkit.js";
import { themeTokens } from "./tokens.js";

afterEach(cleanup);

describe("GitInside mark", () => {
  it("draws the frame in the text color and the node in the accent", () => {
    const { container } = render(<LogoMark size={22} />);
    const svg = container.querySelector("svg.gi-logo-mark");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const path = svg?.querySelector("path");
    expect(path?.getAttribute("d")).toBe(MARK_PATH);
    expect(path?.getAttribute("stroke")).toBe("currentColor");
    const node = svg?.querySelector("circle.gi-logo-mark__node");
    expect(node?.getAttribute("cx")).toBe(String(MARK_NODE.cx));
    expect(node?.getAttribute("r")).toBe(String(MARK_NODE.r));
  });

  it("draws a heavier line below 20px so small marks hold", () => {
    expect(markStroke(12)).toBe(2.5);
    expect(markStroke(16)).toBe(2.5);
    expect(markStroke(20)).toBe(2);
    const stroke = (size: number) =>
      render(<LogoMark size={size} />)
        .container.querySelector("path")
        ?.getAttribute("stroke-width");
    expect(stroke(16)).toBe("2.5");
    expect(stroke(24)).toBe("2");
  });

  it("is the same artwork in the README badge and image", () => {
    const shapes = (svg: string) => [
      svg.match(/<path d="M16\.5 3[^"]*"/)?.[0],
      svg.match(/<circle cx="11\.5" cy="12" r="3"/)?.[0],
    ];
    const expected = [`<path d="${MARK_PATH}"`, `<circle cx="11.5" cy="12" r="3"`];
    expect(shapes(renderBadge({ message: "view diagram" }))).toEqual(expected);
    expect(shapes(renderDiagram(shopDemo()))).toEqual(expected);
    expect(markMarkup({ frame: "var(--text)", node: "var(--accent)", size: 16 })).toContain(
      'style="stroke:var(--text)"',
    );
  });

  it("keeps the node at 3:1 against the canvas in both themes", () => {
    for (const t of [themeTokens.dark, themeTokens.light]) {
      expect(contrastRatio(t.accent, t.canvas)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.text, t.canvas)).toBeGreaterThanOrEqual(3);
    }
  });
});
