// @vitest-environment node
// Checks the built @gitinside/viewer as this app consumes it (turbo builds it
// before this package's tests). Vitest would transform CSS imports away, so
// the import itself runs in a plain Node child process.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("./", import.meta.url));
const dist = (file: string) =>
  readFileSync(new URL(`./node_modules/@gitinside/viewer/dist/${file}`, import.meta.url), "utf8");

describe("@gitinside/viewer as built", () => {
  it("imports in plain Node, with no CSS left in the main entry (ADR-0056)", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import('@gitinside/viewer'); console.log(typeof m.ViewerRoot);",
      ],
      { cwd: appDir, encoding: "utf8" },
    );
    expect(out.trim()).toBe("function");
  });

  it("marks its main entry as client code, so server components can render it", () => {
    expect(dist("index.js").startsWith('"use client";')).toBe(true);
  });

  it("serves the README images from a server entry: plain Node, no client banner (ADR-0071)", () => {
    expect(dist("image.js").startsWith('"use client"')).toBe(false);
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import('@gitinside/viewer/image'); console.log(m.renderBadge({ message: 'ok' }).slice(0, 4));",
      ],
      { cwd: appDir, encoding: "utf8" },
    );
    expect(out.trim()).toBe("<svg");
  });

  it("keeps the fonts in their own entry", () => {
    const fonts = dist("fonts.js");
    expect(fonts).toContain('import "@fontsource-variable/geist/index.css"');
    expect(fonts).toContain('import "@fontsource-variable/geist-mono/index.css"');
    expect(fonts.startsWith('"use client"')).toBe(false);
  });
});
