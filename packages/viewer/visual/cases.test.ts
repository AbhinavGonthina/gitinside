// @vitest-environment node
import { describe, expect, it } from "vitest";
import { visualCases } from "./cases.js";

function index(entries: Record<string, { type: string; title: string; name: string }>) {
  return {
    v: 5,
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, e]) => [id, { id, importPath: "./x.stories.tsx", ...e }]),
    ),
  };
}

describe("visualCases", () => {
  it("lists every story once per theme, dark first, sorted by story id", () => {
    const cases = visualCases(
      index({
        "nodes--states": { type: "story", title: "Components/Nodes", name: "States" },
        "edges--kinds": { type: "story", title: "Components/Edges", name: "Kinds" },
      }),
    );
    expect(cases.map((c) => c.snapshot)).toEqual([
      "edges--kinds--dark.png",
      "edges--kinds--light.png",
      "nodes--states--dark.png",
      "nodes--states--light.png",
    ]);
    expect(cases[1]).toEqual({
      storyId: "edges--kinds",
      theme: "light",
      title: "Components/Edges / Kinds (light)",
      snapshot: "edges--kinds--light.png",
      url: "/iframe.html?id=edges--kinds&viewMode=story&globals=theme:light",
    });
  });

  it("skips docs entries", () => {
    const cases = visualCases(
      index({
        "nodes--docs": { type: "docs", title: "Components/Nodes", name: "Docs" },
        "nodes--states": { type: "story", title: "Components/Nodes", name: "States" },
      }),
    );
    expect(cases.map((c) => c.storyId)).toEqual(["nodes--states", "nodes--states"]);
  });

  it("refuses an index with no stories, so an empty build can't pass", () => {
    expect(() => visualCases(index({}))).toThrow(/no stories/);
  });

  it("refuses an index it doesn't understand", () => {
    expect(() => visualCases({ v: 4, stories: {} })).toThrow(/index\.json/);
    expect(() => visualCases(null)).toThrow(/index\.json/);
    expect(() =>
      visualCases({ v: 5, entries: { a: { id: "a", type: "story", title: "T" } } }),
    ).toThrow(/index\.json/);
  });

  it("refuses story ids that aren't safe file names", () => {
    expect(() => visualCases(index({ "../x": { type: "story", title: "T", name: "N" } }))).toThrow(
      /story id/,
    );
  });
});
