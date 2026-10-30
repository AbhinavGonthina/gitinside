// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CONTEXT_LINES } from "../chrome/syntax.js";
import { previewLines } from "./panels.js";

const file = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\r\n");

describe("previewLines", () => {
  it("shows 15 lines from 4 above the selection, with the lines above for the highlighter", () => {
    const preview = previewLines(file(500), 300);
    expect(preview.startLine).toBe(296);
    expect(preview.highlight).toBe(300);
    expect(preview.lines).toHaveLength(15);
    expect(preview.lines[0]).toBe("line 296");
    expect(preview.before).toHaveLength(CONTEXT_LINES);
    expect(preview.before.at(0)).toBe(`line ${296 - CONTEXT_LINES}`);
    expect(preview.before.at(-1)).toBe("line 295");
  });

  it("starts at the top near the start of a file, and ends at its end near the end", () => {
    const top = previewLines(file(40), 2);
    expect(top.startLine).toBe(1);
    expect(top.before).toEqual([]);
    const end = previewLines(file(40), 39);
    expect(end.startLine).toBe(26);
    expect(end.lines.at(-1)).toBe("line 40");
    expect(end.before).toHaveLength(25);
  });
});
