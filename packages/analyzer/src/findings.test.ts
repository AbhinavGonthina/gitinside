import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { createFindings, findingsOf, type AnalysisFindings } from "./findings.js";

const store = (id: string, label: string): GraphNode => ({
  id,
  kind: "datastore",
  label,
  parentId: "system",
  engine: "postgres",
});
const external = (id: string, label: string): GraphNode => ({
  id,
  kind: "external",
  label,
  parentId: "system",
  host: label,
});

describe("createFindings", () => {
  it("counts a node ID once, keeping the first label, as assembly does", () => {
    const seen: AnalysisFindings[] = [];
    const found = createFindings((event) => seen.push(event));
    found.add(["stores"], [store("datastore:b", "b"), store("datastore:a", "a")]);
    found.add(["stores"], [store("datastore:a", "renamed"), store("datastore:c", "c")]);
    expect(seen).toEqual([{ stores: ["a", "b"] }, { stores: ["a", "b", "c"] }]);
  });

  it("reports only the keys looked for, never unresolved nodes", () => {
    const seen: AnalysisFindings[] = [];
    const found = createFindings((event) => seen.push(event));
    const unresolved: GraphNode = {
      id: "unresolved:x",
      kind: "unresolved",
      label: "fetch(url)",
      parentId: "system",
      reason: "DYNAMIC_URL",
      expression: "url",
    };
    found.add(["externals"], [unresolved, external("external:stripe", "api.stripe.com")]);
    expect(seen).toEqual([{ externals: ["api.stripe.com"] }]);
  });

  it("does nothing without a listener", () => {
    expect(() => createFindings().add(["stores"], [store("datastore:a", "a")])).not.toThrow();
  });
});

describe("findingsOf", () => {
  it("has every key, sorted with compareStrings", () => {
    expect(findingsOf([external("e:b", "b"), external("e:B", "B")])).toEqual({
      services: [],
      routes: 0,
      pages: 0,
      stores: [],
      externals: ["B", "b"],
    });
  });
});
