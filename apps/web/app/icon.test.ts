// @vitest-environment node
import { readFileSync } from "node:fs";
import { MARK_NODE, MARK_PATH, markStroke, themeTokens } from "@gitinside/viewer";
import { describe, expect, it } from "vitest";

// The favicon is a static file (Next serves app/icon.svg as is), so it is a
// copy of the mark; this keeps the copy in step with the viewer's geometry.
const icon = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

describe("favicon", () => {
  it("draws the GitInside mark's frame and node, stroked for a 16px tab", () => {
    expect(icon).toContain(`d="${MARK_PATH}"`);
    expect(icon).toContain(`stroke-width="${markStroke(16)}"`);
    expect(icon).toContain(`cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}"`);
  });

  it("paints it in the theme's text and accent, following the system scheme", () => {
    const [light, dark] = icon.split("prefers-color-scheme: dark");
    expect(light).toContain(`.frame { stroke: ${themeTokens.light.text}; }`);
    expect(light).toContain(`.node { fill: ${themeTokens.light.accent}; }`);
    expect(dark).toContain(`.frame { stroke: ${themeTokens.dark.text}; }`);
    expect(dark).toContain(`.node { fill: ${themeTokens.dark.accent}; }`);
  });
});
