import type { GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import type { ChangeItem } from "../model/diff.js";
import { changeDetail, renameWords } from "./changes.js";

// The changes list's words (M6.9d): renames and moves, changed fields, and
// added or removed nodes, each from the diff's records alone.

const file = (path: string): GraphNode => ({
  id: `file:app/${path}`,
  kind: "file",
  label: path.slice(path.lastIndexOf("/") + 1),
  parentId: null,
  path,
  hash: "h",
});

const fn = (label: string, at: string): GraphNode => ({
  id: `symbol:app/${at}#${label}`,
  kind: "symbol",
  label,
  parentId: null,
  symbolKind: "function",
  exported: true,
  source: { file: at, line: 3, column: 1 },
});

const changed = (from: GraphNode | undefined, fields: string[]): ChangeItem => ({
  status: "changed",
  id: "x",
  label: "x",
  kind: "file",
  fields,
  from,
  inside: 0,
});

describe("renameWords", () => {
  it("says where a file moved from, its old path holding its old name", () => {
    expect(renameWords(file("src/orders/routes.ts"), file("src/routes/orders.ts"))).toBe(
      "Moved from src/routes/orders.ts",
    );
    expect(renameWords(file("lib/orders.ts"), file("src/orders.ts"))).toBe(
      "Moved from src/orders.ts",
    );
  });

  it("gives a file renamed in its folder its old name", () => {
    expect(renameWords(file("src/order.ts"), file("src/orders.ts"))).toBe("Renamed from orders.ts");
  });

  it("says which file a symbol was in, and its old name when that changed too", () => {
    expect(renameWords(fn("quote", "src/pricing.ts"), fn("price", "src/pricing.ts"))).toBe(
      "Renamed from price",
    );
    expect(renameWords(fn("quote", "src/pricing.ts"), fn("quote", "src/cart.ts"))).toBe(
      "Moved from src/cart.ts",
    );
    expect(renameWords(fn("quote", "src/pricing.ts"), fn("price", "src/cart.ts"))).toBe(
      "Renamed from price, moved from src/cart.ts",
    );
  });
});

describe("changeDetail", () => {
  it("names the changed fields a reader cares about, not labels or positions", () => {
    const node = file("src/a.ts");
    expect(changeDetail(changed(undefined, ["hash"]), node)).toBe("Code changed");
    expect(changeDetail(changed(undefined, ["method", "path", "label"]), node)).toBe(
      "Method and path changed",
    );
    expect(
      changeDetail(changed(undefined, ["fields", "requiredParams", "source", "layer"]), node),
    ).toBe("Fields, required parameters, and layer changed");
    expect(changeDetail(changed(undefined, ["source"]), node)).toBe("Changed");
  });

  it("adds what else changed to a rename, leaving out the move it already says", () => {
    const node = file("src/orders/routes.ts");
    const from = file("src/routes/orders.ts");
    expect(changeDetail(changed(from, ["label", "parentId", "path"]), node)).toBe(
      "Moved from src/routes/orders.ts",
    );
    expect(changeDetail(changed(from, ["hash", "label", "path"]), node)).toBe(
      "Moved from src/routes/orders.ts · code changed",
    );
  });

  it("says what an added or removed node is, where, and what came with it", () => {
    const node = file("src/legacy.ts");
    const removed: ChangeItem = {
      status: "removed",
      id: node.id,
      label: "legacy.ts",
      kind: "file",
      inside: 0,
    };
    expect(changeDetail(removed, node)).toBe("File · src/legacy.ts");
    expect(changeDetail({ ...removed, inside: 1_204 }, node)).toBe(
      "File · src/legacy.ts · 1,204 more inside",
    );
    const route: GraphNode = {
      id: "route:app/GET /a",
      kind: "route",
      label: "GET /a",
      parentId: null,
      method: "GET",
      path: "/a",
    };
    expect(changeDetail({ ...removed, status: "added", id: route.id }, route)).toBe("Route");
  });

  it("quotes a broken connection's own words", () => {
    const node = fn("placeOrder", "src/client.ts");
    const broken: ChangeItem = {
      status: "broken",
      id: node.id,
      label: "placeOrder",
      kind: "symbol",
      inside: 0,
      broken: {
        edge: "e",
        from: node.id,
        to: "route:app/POST /a",
        reason: "ROUTE_CHANGED",
        detail: "POST /a is now PUT /a",
      },
    };
    expect(changeDetail(broken, node)).toBe("POST /a is now PUT /a");
  });
});
