import { SCHEMA_VERSION, SYSTEM_ID, type ArchitectureGraph } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { checkComparable, describeRepo, IncompatibleGraphsError } from "./index.js";

const graph = (analyzerVersion: string, sha?: string): ArchitectureGraph => ({
  schemaVersion: SCHEMA_VERSION,
  repo: sha === undefined ? { owner: "acme", name: "shop" } : { owner: "acme", name: "shop", sha },
  analyzerVersion,
  nodes: [{ id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null }],
  edges: [],
  warnings: [],
});

describe("checkComparable", () => {
  it("accepts two graphs from the same analyzer version, whatever their repos", () => {
    const fork = { ...graph("0.1.0", "d4e5f60"), repo: { owner: "someone", name: "shop" } };
    expect(() => checkComparable(graph("0.1.0", "a1b2c3f"), fork)).not.toThrow();
  });

  it("refuses graphs from two analyzer versions and says what to do", () => {
    const run = () => checkComparable(graph("0.1.0", "a1b2c3f"), graph("0.2.0"));
    expect(run).toThrow(IncompatibleGraphsError);
    expect(run).toThrow(
      "acme/shop@a1b2c3f was analyzed with analyzer 0.1.0 and acme/shop with 0.2.0; analyze both with the same version",
    );
  });
});

describe("describeRepo", () => {
  it("names the commit when the graph has one", () => {
    expect(describeRepo({ owner: "acme", name: "shop", sha: "a1b2c3f" })).toBe("acme/shop@a1b2c3f");
    expect(describeRepo({ owner: "acme", name: "shop" })).toBe("acme/shop");
  });
});
