// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), "utf8");
const css = read("transitions.css");

/** The body of the first `<selector> {` block in the sheet, nested blocks included. */
function block(sheet: string, selector: string): string | undefined {
  const start = sheet.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = sheet.indexOf("{", start); i < sheet.length; i++) {
    if (sheet[i] === "{") depth++;
    if (sheet[i] === "}" && --depth === 0) return sheet.slice(sheet.indexOf("{", start) + 1, i);
  }
  return undefined;
}

// Asserted as booleans with a message, so a failure names the rule rather than printing the sheet.
describe("the prototype's page transitions (M10.3e2b, M10-design §4)", () => {
  it("opts in to cross-document View Transitions only without reduced motion, and only on the prototype", () => {
    const motion = block(css, "@media (prefers-reduced-motion: no-preference)") ?? "";
    expect(/@view-transition \{\s*navigation: auto;\s*\}/.test(motion), "opt-in").toBe(true);
    // Nowhere else: not outside the media query, and not in the shipped site's sheet.
    expect(css.split("@view-transition").length, "one opt-in").toBe(2);
    expect(read("../globals.css").includes("@view-transition"), "globals.css").toBe(false);
    // The sheet loads with the prototype's route only.
    expect(read("page.tsx").includes('import "./transitions.css";'), "page.tsx").toBe(true);
    expect(read("api/page.tsx").includes('import "../transitions.css";'), "api/page.tsx").toBe(
      true,
    );
  });

  it("fades the page it leaves over `fast` with the exit curve, and keeps the bar still", () => {
    const old = block(css, "::view-transition-old(root)") ?? "";
    expect(
      /animation: page-leave var\(--duration-fast\) var\(--ease-exit\) both;/.test(old),
      "leaving",
    ).toBe(true);
    expect(/opacity: 0;/.test(block(css, "@keyframes page-leave") ?? ""), "page-leave").toBe(true);
    // Drawn above the arriving page (opaque, not fading), or the fade never shows, and without
    // the browser's `plus-lighter` crossfade blend (a real-browser frame at 60ms caught both).
    expect(/z-index: 1;/.test(old), "old above").toBe(true);
    expect(/mix-blend-mode: normal;/.test(old), "old blend").toBe(true);
    // The arriving page plays its own entrance, live, rather than a second fade on top.
    expect(/animation: none;/.test(block(css, "::view-transition-new(root)") ?? ""), "new").toBe(
      true,
    );
    // One bar on either page, named alike and swapped at once: it neither fades nor slides.
    expect(css.split("view-transition-name: page-bar;").length, "named bars").toBe(2);
    const bar = block(
      css,
      "::view-transition-group(page-bar),\n::view-transition-old(page-bar),\n::view-transition-new(page-bar)",
    );
    expect(/animation: none;/.test(bar ?? ""), "bar").toBe(true);
    expect(/opacity: 0;/.test(block(css, "::view-transition-old(page-bar)") ?? ""), "old bar").toBe(
      true,
    );
  });

  it("brings the content in with a 4px rise over `standard`, with no fill, in every browser", () => {
    const enter = block(css, "@keyframes page-enter") ?? "";
    expect(/from \{\s*opacity: 0;\s*translate: 0 4px;\s*\}/.test(enter), "page-enter").toBe(true);
    // No fill: an entrance left in effect after it ends shifts text a few pixels in screenshots.
    const content =
      /\{\s*animation: page-enter var\(--duration-standard\) var\(--ease-standard\);\s*\}/;
    expect(content.test(css), "entrance").toBe(true);
    // Under reduced motion the tokens' durations are 0ms, so it's instant there.
    expect(/animation: page-enter[^;]*\d+ms/.test(css), "token durations only").toBe(false);
  });
});
