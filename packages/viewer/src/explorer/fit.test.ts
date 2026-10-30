// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitScale } from "./fit.js";

describe("fitScale", () => {
  it("fits the diagram in the canvas, between 40% and 100%", () => {
    expect(fitScale({ width: 1000, height: 500 }, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ width: 500, height: 300 }, { width: 2000, height: 2000 })).toBe(1);
    expect(fitScale({ width: 1048, height: 400 }, { width: 1000, height: 900 })).toBe(0.9);
    expect(fitScale({ width: 10000, height: 400 }, { width: 1000, height: 900 })).toBe(0.4);
  });
});
