// @vitest-environment node
// (No DOM needed, and jsdom's URL rejects the file: URLs used below.)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio, relativeLuminance } from "./contrast.js";
import { cssVar, durations, scaleTokens, themeTokens, type ThemeTokenName } from "./tokens.js";

const css = readFileSync(fileURLToPath(new URL("./styles/tokens.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\r\n/g, "\n");

const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\})\s*\}/.exec(css);
const mainCss = reducedMotion ? css.replace(reducedMotion[0], "") : css;

/** The custom properties declared by the rule with exactly this selector. */
function declarations(source: string, selector: string): Record<string, string> {
  const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1]!.trim() === selector,
  );
  expect(rules, `one rule for ${selector}`).toHaveLength(1);
  const props: Record<string, string> = {};
  for (const [, name, value] of rules[0]![2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    props[name!] = value!.trim();
  }
  return props;
}

const surfaces: ThemeTokenName[] = ["canvas", "surface-1", "surface-2", "surface-raised"];
const textTokens: ThemeTokenName[] = ["text", "text-muted"];
const graphicTokens: ThemeTokenName[] = [
  "accent",
  "layer-frontend",
  "layer-backend",
  "layer-data",
  "layer-infra",
  "layer-external",
  "trace",
  "diff-added",
  "diff-changed",
  "diff-removed",
];

describe("tokens.css", () => {
  it("declares exactly the shared scale tokens on .gi-root", () => {
    expect(declarations(mainCss, ".gi-root")).toEqual(scaleTokens);
  });

  it.each(["dark", "light"] as const)("declares exactly the %s theme tokens", (theme) => {
    expect(declarations(mainCss, `.gi-root[data-theme="${theme}"]`)).toEqual(themeTokens[theme]);
  });

  it("zeroes every duration under prefers-reduced-motion", () => {
    expect(reducedMotion).not.toBeNull();
    const durationNames = Object.keys(scaleTokens).filter((n) => n.startsWith("duration-"));
    expect(declarations(reducedMotion![1]!, ".gi-root")).toEqual(
      Object.fromEntries(durationNames.map((n) => [n, "0ms"])),
    );
  });

  it("gives focus a 2px accent ring", () => {
    expect(mainCss).toMatch(
      /\.gi-root :focus-visible \{\s*outline: 2px solid var\(--accent\);\s*outline-offset: 2px;\s*\}/,
    );
  });

  it("never loads anything from another origin", () => {
    const index = readFileSync(
      fileURLToPath(new URL("./styles/index.css", import.meta.url)),
      "utf8",
    );
    expect(css + index).not.toMatch(/https?:|\/\//);
  });
});

describe("fonts", () => {
  const fonts = readFileSync(fileURLToPath(new URL("./fonts.ts", import.meta.url)), "utf8");

  it.each(["@fontsource-variable/geist", "@fontsource-variable/geist-mono"])(
    "imports %s, whose font files are all local to the package",
    (pkg) => {
      expect(fonts).toContain(`import "${pkg}/index.css";`);
      const faces = readFileSync(
        createRequire(import.meta.url).resolve(`${pkg}/index.css`),
        "utf8",
      );
      const urls = [...faces.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toMatch(/^\.\/files\/[\w-]+\.woff2$/);
    },
  );

  it("are their own entry, so the main entry imports no package CSS (ADR-0056)", () => {
    const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const imports = [...index.matchAll(/^import\s+(?:[^"';]*from\s+)?["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    // The library build extracts the viewer's own stylesheet into style.css;
    // anything else with side effects would stay an import in dist/index.js.
    expect(imports.filter((s) => !s!.startsWith("./") || s!.endsWith(".css"))).toEqual([
      "./styles/index.css",
    ]);
    expect(imports).not.toContain("./fonts.js");
  });

  it("are first in the font stacks", () => {
    expect(scaleTokens["font-sans"].startsWith('"Geist Variable",')).toBe(true);
    expect(scaleTokens["font-mono"].startsWith('"Geist Mono Variable",')).toBe(true);
    const faces = (pkg: string) =>
      readFileSync(createRequire(import.meta.url).resolve(`${pkg}/index.css`), "utf8");
    expect(faces("@fontsource-variable/geist")).toContain("font-family: 'Geist Variable';");
    expect(faces("@fontsource-variable/geist-mono")).toContain(
      "font-family: 'Geist Mono Variable';",
    );
  });
});

describe("theme tokens", () => {
  it("define the same names in both themes", () => {
    expect(Object.keys(themeTokens.light).sort()).toEqual(Object.keys(themeTokens.dark).sort());
  });

  it("keep the light canvas the cool off-white from DESIGN_SYSTEM.md", () => {
    expect(themeTokens.light.canvas).toBe("#f5f7fa");
    expect(relativeLuminance(themeTokens.light.canvas)).toBeGreaterThan(0.9);
  });

  describe.each(["dark", "light"] as const)("%s theme meets WCAG 2.2 AA", (theme) => {
    const t = themeTokens[theme];
    it.each(textTokens.flatMap((fg) => surfaces.map((bg) => [fg, bg] as const)))(
      "%s on %s is at least 4.5:1 (text)",
      (fg, bg) => {
        expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
      },
    );
    it.each(graphicTokens.flatMap((fg) => surfaces.map((bg) => [fg, bg] as const)))(
      "%s on %s is at least 3:1 (graphics and focus)",
      (fg, bg) => {
        expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
      },
    );
  });

  it("give every layer its own color", () => {
    for (const theme of ["dark", "light"] as const) {
      const layers = graphicTokens
        .filter((n) => n.startsWith("layer-"))
        .map((n) => themeTokens[theme][n]);
      expect(new Set(layers).size).toBe(layers.length);
    }
  });
});

describe("scale tokens", () => {
  it("follow the 4px spacing base and the type scale", () => {
    const spaces = Object.entries(scaleTokens).filter(([n]) => n.startsWith("space-"));
    expect(spaces.map(([, v]) => v)).toEqual([
      "4px",
      "8px",
      "12px",
      "16px",
      "24px",
      "32px",
      "48px",
    ]);
    for (const [name, value] of spaces) expect(value).toBe(`${name.slice("space-".length)}px`);
    const sizes = Object.keys(scaleTokens).filter((n) => n.startsWith("font-size-"));
    expect(sizes.map((n) => scaleTokens[n as keyof typeof scaleTokens])).toEqual([
      "12px",
      "13px",
      "14px",
      "16px",
      "20px",
      "28px",
    ]);
  });

  it("derive CSS durations from the JS durations", () => {
    expect(scaleTokens["duration-layout"]).toBe(`${durations.layout}ms`);
    expect(scaleTokens["duration-trace-hop"]).toBe(`${durations["trace-hop"]}ms`);
  });

  it("ease without overshoot, and exits accelerate away (ADR-0104)", () => {
    const eases = Object.entries(scaleTokens).filter(([n]) => n.startsWith("ease-"));
    expect(eases.map(([n]) => n)).toEqual(["ease-standard", "ease-layout", "ease-exit"]);
    for (const [, value] of eases) {
      const points = /^cubic-bezier\(([^)]*)\)$/.exec(value)?.[1]?.split(",").map(Number) ?? [];
      expect(points).toHaveLength(4);
      // y outside [0, 1] is a bounce or a wind-up: a generated-UI tell.
      for (const y of [points[1], points[3]]) expect(y).toBeGreaterThanOrEqual(0);
      for (const y of [points[1], points[3]]) expect(y).toBeLessThanOrEqual(1);
    }
    // Exits start slow and leave fast; entrances do the opposite.
    const [x1, y1] = scaleTokens["ease-exit"].slice(13, -1).split(",").map(Number);
    expect(x1! > y1!).toBe(true);
  });
});

describe("cssVar", () => {
  it("wraps a token name in var()", () => {
    expect(cssVar("accent")).toBe("var(--accent)");
    expect(cssVar("radius-card")).toBe("var(--radius-card)");
  });
});

describe("contrastRatio", () => {
  it("spans 1 to 21 and is symmetric", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#2F5FD0", "#F5F7FA")).toBe(contrastRatio("#F5F7FA", "#2F5FD0"));
  });

  it("rejects anything but #RRGGBB", () => {
    expect(() => relativeLuminance("#FFF")).toThrow(/#RRGGBB/);
    expect(() => relativeLuminance("rgba(0, 0, 0, 1)")).toThrow(/#RRGGBB/);
  });
});
