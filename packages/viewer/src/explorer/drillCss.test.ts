// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const css = read("../styles/drill.css");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("drill.css", () => {
  it("is part of the stylesheet entry", () => {
    expect(read("../styles/index.css")).toContain('@import "./drill.css";');
  });

  it("takes every color from tokens and times motion with the duration tokens", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\brgba?\(|\bhsla?\(/);
    const timed = body.match(/\b(?:transition|animation):[^;]*;/g) ?? [];
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t).not.toMatch(/\d+m?s\b/);
    expect(body).toMatch(
      /\.gi-drill__stage \{[^}]*width var\(--duration-layout\) var\(--ease-layout\)/,
    );
  });

  it("layers open frames under the lines, and boxes and pills over them", () => {
    const z = (selector: string) =>
      new RegExp(`${selector.replace(/[.[\]>]/g, "\\$&")} \\{[^}]*z-index: (\\d)`).exec(body)?.[1];
    expect(z(".gi-drill__node[data-open]")).toBe("0");
    expect(z(".gi-drill__lines")).toBe("1");
    expect(z(".gi-drill__node")).toBe("2");
    expect(z(".gi-drill__labels")).toBe("3");
  });

  it("keeps an open file's own row at the top, above its children (M4b.3a)", () => {
    expect(body).toMatch(
      /\.gi-drill__node\[data-open\] > \.gi-node:not\(\[data-tier="frame"\]\) \{\s*align-items: flex-start;/,
    );
  });

  describe("zoom-dependent detail (M4b.4b)", () => {
    /** The declarations of the rule whose selector, whitespace collapsed, is `selector`. */
    const rule = (selector: string) => {
      for (const m of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if ((m[1] ?? "").replace(/\s+/g, " ").trim() === selector) return m[2] ?? "";
      }
      throw new Error(`no rule ${selector}`);
    };

    it("fades secondary text out below full detail, but never the names or the diff tag", () => {
      const hides = rule(
        '.gi-drill:is([data-detail="names"], [data-detail="outline"]) .gi-node :is(.gi-node__subtitle, .gi-node__badges, .gi-node__fields)',
      );
      expect(hides).toMatch(/opacity: 0;/);
      expect(body).not.toMatch(/data-detail="names"\][^{]*gi-node__label/);
      expect(body).not.toMatch(/gi-node__diff/);
    });

    it("keeps the selection's, the current hop's, and a broken edge's pill at names detail", () => {
      expect(
        rule(
          '.gi-drill[data-detail="names"] .gi-edge-label:not([data-selected], [data-emphasis="current"], [data-broken])',
        ),
      ).toMatch(/opacity: 0;/);
      expect(rule('.gi-drill[data-detail="outline"] .gi-edge-label')).toMatch(/opacity: 0;/);
    });

    it("keeps only service names in the outline, and any box being looked at", () => {
      expect(
        rule(
          '.gi-drill[data-detail="outline"] .gi-node:not( [data-kind="service"], [data-selected], [data-emphasis="traced"], [data-emphasis="current"], :hover, :focus-visible ) .gi-node__label',
        ),
      ).toMatch(/opacity: 0;/);
    });

    it("drops a service's inner lines from the outline unless selected, traced, or broken, and they can't be pointed at", () => {
      const inner =
        '.gi-drill[data-detail="outline"] .gi-edge[data-inner]:not( [data-selected], [data-emphasis="traced"], [data-emphasis="current"], [data-broken] )';
      expect(rule(inner)).toMatch(/opacity: 0;[^]*pointer-events: none;/);
      expect(rule(`${inner} .gi-edge__hit`)).toMatch(/pointer-events: none;/);
    });

    it("scales a service's name from its left edge, narrowing it by the same factor", () => {
      const name = rule('.gi-drill .gi-node[data-kind="service"] .gi-node__label');
      expect(name).toMatch(/width: calc\(100% \/ var\(--gi-name-scale, 1\)\);/);
      expect(name).toMatch(/transform: scale\(var\(--gi-name-scale, 1\)\);/);
      expect(name).toMatch(/transform-origin: 0 50%;/);
      expect(name).toMatch(
        /opacity var\(--duration-standard\)[^;]*transform var\(--duration-standard\)/,
      );
    });

    it("fades with the standard duration, keeping the fields row's color transitions", () => {
      expect(
        rule(".gi-drill .gi-node :is(.gi-node__label, .gi-node__subtitle, .gi-node__badges)"),
      ).toMatch(/opacity var\(--duration-standard\) var\(--ease-standard\)/);
      const fields = rule(".gi-drill .gi-node .gi-node__fields");
      expect(fields).toMatch(/background-color var\(--duration-fast\)/);
      expect(fields).toMatch(/border-color var\(--duration-fast\)/);
      expect(fields).toMatch(/opacity var\(--duration-standard\)/);
    });
  });

  it("lets clicks through the pills' layer and past a folding box", () => {
    expect(body).toMatch(/\.gi-drill__labels \{[^}]*pointer-events: none/);
    expect(body).toMatch(/\.gi-drill__node\[data-leaving\] \{[^}]*pointer-events: none/);
  });
});
