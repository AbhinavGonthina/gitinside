import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  SYSTEM_ID,
  edgeId,
  nodeId,
  parseGraph,
  type ArchitectureGraph,
  type GraphEdge,
  type GraphNode,
} from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { diffGraphs, escapeMermaidLabel, renderMermaidSummary } from "./index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const fixture = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

const summary = (base: ArchitectureGraph, head: ArchitectureGraph, maxNodes?: number) =>
  renderMermaidSummary(
    diffGraphs(base, head),
    base,
    head,
    maxNodes === undefined ? {} : { maxNodes },
  );

describe("renderMermaidSummary on the diff-broken fixture pair", () => {
  const base = fixture("diff-broken-base");
  const head = fixture("diff-broken-head");

  it("draws broken connections first, then changed routes and models, then lifted edges", () => {
    expect(summary(base, head)).toBe(
      [
        "flowchart LR",
        '  n1["function quote"]',
        '  n2["function withTax - Changed"]',
        '  n3["function cancelOrder"]',
        '  n4(["DELETE /api/orders/:id - Removed"])',
        '  n5["function placeOrder"]',
        '  n6(["POST /api/orders - Removed"])',
        '  n7["file client.ts - Changed"]',
        '  n8["file legacy.ts - Removed"]',
        '  n9["function invoiceTotal"]',
        '  n10[("model Invoice - Removed")]',
        '  n11["function openOrders"]',
        '  n12[("model Order - Changed")]',
        '  n13(["GET /api/health - Removed"])',
        '  n14(["PUT /api/orders - Added"])',
        '  n15[("datastore postgres")]',
        '  n16["service diff-broken"]',
        '  n1 -.->|"Broken: needs more arguments"| n2',
        '  n3 -.->|"Broken: target removed"| n4',
        '  n5 -.->|"Broken: route changed"| n6',
        '  n7 -.->|"Broken: target removed"| n8',
        '  n9 -.->|"Broken: target removed"| n10',
        '  n11 -.->|"Broken: field removed"| n12',
        '  n10 -.->|"Removed stores"| n15',
        '  n16 -.->|"Removed writes"| n12',
        '  n16 -.->|"Removed http"| n13',
        "  classDef added stroke:#1e8e4e,stroke-width:2px",
        "  class n14 added",
        "  classDef removed stroke:#d23b3b,stroke-width:2px,stroke-dasharray:5 3",
        "  class n4,n6,n8,n10,n13 removed",
        "  classDef changed stroke:#a87700,stroke-width:2px",
        "  class n2,n7,n12 changed",
        "  linkStyle 0,1,2,3,4,5 stroke:#d23b3b,stroke-width:3px,stroke-dasharray:5 3",
        "  linkStyle 6,7,8 stroke:#d23b3b,stroke-width:2px,stroke-dasharray:5 3",
        "",
      ].join("\n"),
    );
  });

  it("is deterministic and doesn't depend on the input order", () => {
    const shuffled = {
      ...head,
      nodes: [...head.nodes].reverse(),
      edges: [...head.edges].reverse(),
    };
    expect(summary(base, shuffled)).toBe(summary(base, head));
  });

  it("past maxNodes, keeps broken endpoints and counts the rest in a note", () => {
    const text = summary(base, head, 4);
    expect(text).toContain('  n4(["DELETE /api/orders/:id - Removed"])');
    expect(text).not.toContain("n5");
    expect(text).toContain('  n1 -.->|"Broken: needs more arguments"| n2');
    expect(text).toContain('  more["...and 12 more nodes and 7 more connections not drawn"]');
    // Styles name only drawn nodes and number only drawn links.
    expect(text).toContain("  class n4 removed");
    expect(text).toContain("  linkStyle 0,1 stroke:#d23b3b,stroke-width:3px");
  });

  it("says so when nothing at the architecture level changed", () => {
    expect(summary(base, base)).toBe('flowchart LR\n  none["No architecture-level changes"]\n');
  });
});

describe("renderMermaidSummary on hand-built graphs", () => {
  const web = nodeId("service", "web", "");
  const api = nodeId("service", "api", "");
  const page = nodeId("file", "web", "src/page.ts");
  const load = nodeId("symbol", "web", "src/page.ts#load");
  const server = nodeId("file", "api", "src/server.ts");
  const list = nodeId("route", "api", "GET /api/orders");
  const order = nodeId("model", "api", "Order");

  const nodes: GraphNode[] = [
    { id: SYSTEM_ID, kind: "system", label: "acme/shop", parentId: null },
    { id: web, kind: "service", label: "web", parentId: SYSTEM_ID, root: "apps/web" },
    { id: api, kind: "service", label: "api", parentId: SYSTEM_ID, root: "apps/api" },
    {
      id: page,
      kind: "file",
      label: "page.ts",
      parentId: web,
      path: "apps/web/src/page.ts",
      hash: "a".repeat(64),
    },
    {
      id: load,
      kind: "symbol",
      label: "load",
      parentId: page,
      symbolKind: "function",
      exported: true,
    },
    {
      id: server,
      kind: "file",
      label: "server.ts",
      parentId: api,
      path: "apps/api/src/server.ts",
      hash: "b".repeat(64),
    },
    {
      id: list,
      kind: "route",
      label: "GET /api/orders",
      parentId: server,
      method: "GET",
      path: "/api/orders",
    },
    { id: order, kind: "model", label: "Order", parentId: api, fields: [] },
  ];
  const edge = (kind: GraphEdge["kind"], from: string, to: string): GraphEdge => ({
    id: edgeId(kind, from, to),
    kind,
    from,
    to,
    confidence: "exact",
    sites: [{ file: "apps/web/src/page.ts", line: 3, column: 1 }],
  });
  const graph = (n: GraphNode[], edges: GraphEdge[]): ArchitectureGraph =>
    parseGraph({
      schemaVersion: SCHEMA_VERSION,
      repo: { owner: "acme", name: "shop" },
      analyzerVersion: "0.1.0",
      nodes: n,
      edges,
      warnings: [],
    });

  it("lifts new connections to the services and merges kinds per pair", () => {
    const base = graph(nodes, []);
    const head = graph(nodes, [
      edge("http", load, list),
      edge("reads", load, order),
      edge("writes", load, order),
      edge("calls", load, load),
    ]);
    expect(summary(base, head)).toBe(
      [
        "flowchart LR",
        '  n1["service web"]',
        '  n2[("model Order")]',
        '  n3(["GET /api/orders"])',
        '  n1 -->|"Added reads, writes"| n2',
        '  n1 -->|"Added http"| n3',
        "  linkStyle 0,1 stroke:#1e8e4e,stroke-width:2px",
        "",
      ].join("\n"),
    );
  });

  it("draws a changed connection and a renamed route", () => {
    const base = graph(nodes, [edge("http", load, list)]);
    const renamed = nodeId("route", "api", "GET /api/v2/orders");
    const moved: GraphNode = {
      ...(nodes[6] as GraphNode),
      id: renamed,
      label: "GET /api/v2/orders",
    };
    const head = graph(
      nodes.map((n) => (n.id === list ? ({ ...moved, path: "/api/v2/orders" } as GraphNode) : n)),
      [{ ...edge("http", load, renamed), confidence: "pattern" }],
    );
    const diff = diffGraphs(base, head);
    // The analyzer would leave this an add + remove; the summary also handles a rename pair.
    const asRename = {
      ...diff,
      nodes: {
        ...diff.nodes,
        added: [],
        removed: [],
        renamed: [
          {
            from: list,
            node: head.nodes.find((n) => n.id === renamed) as GraphNode,
            changes: ["label"],
          },
        ],
      },
      edges: {
        ...diff.edges,
        added: [],
        removed: [],
        modified: [{ edge: head.edges[0] as GraphEdge, changes: ["confidence"] }],
      },
    };
    const text = renderMermaidSummary(asRename, base, head);
    expect(text).toContain('  n1(["GET /api/v2/orders - Renamed from GET /api/orders"])');
    expect(text).toContain('  n2["service web"]');
    expect(text).toContain('  n2 -->|"Changed http"| n1');
    expect(text).toContain("  class n1 changed");
    expect(text).toContain("  linkStyle 0 stroke:#a87700,stroke-width:2px");
  });

  it("names the service when two drawn nodes would read the same", () => {
    const pg = (service: string): Extract<GraphNode, { kind: "datastore" }> => ({
      id: nodeId("datastore", service, "postgres"),
      kind: "datastore",
      label: "postgres",
      parentId: nodeId("service", service, ""),
      engine: "postgres",
    });
    const compose = (file: string): GraphNode => ({
      ...pg("infra"),
      id: nodeId("datastore", "infra", `${file}/redis`),
      label: "redis",
      parentId: SYSTEM_ID,
      engine: "redis",
      source: { file, line: 3, column: 3 },
    });
    const base = graph(nodes, []);
    const head = graph(
      [...nodes, pg("web"), pg("api"), compose("compose.yml"), compose("infra/compose.yml")],
      [],
    );
    const text = summary(base, head);
    expect(text).toContain('[("datastore postgres in api - Added")]');
    expect(text).toContain('[("datastore postgres in web - Added")]');
    expect(text).toContain('[("datastore redis in compose.yml - Added")]');
    expect(text).toContain('[("datastore redis in infra/compose.yml - Added")]');
  });

  it("says a renamed node with an unchanged label moved", () => {
    const base = graph(nodes, []);
    const diff = diffGraphs(base, base);
    const text = renderMermaidSummary(
      {
        ...diff,
        nodes: {
          ...diff.nodes,
          renamed: [{ from: order, node: nodes[7] as GraphNode, changes: [] }],
        },
      },
      base,
      base,
    );
    expect(text).toContain('  n1[("model Order - Moved")]');
  });

  it("escapes repo-controlled labels so they can't break out of the node text", () => {
    const evil = 'x"]; click n1 %%\n<img>';
    const host = nodeId("external", "", "evil.example");
    const base = graph(nodes, []);
    const head = graph(
      [
        ...nodes,
        { id: host, kind: "external", label: evil, parentId: SYSTEM_ID, host: "evil.example" },
      ],
      [],
    );
    const text = summary(base, head);
    const line = text.split("\n").find((l) => l.startsWith("  n1")) as string;
    expect(line).toMatch(/^ {2}n1\{\{"[A-Za-z0-9 ._,()/:@#;-]*"\}\}$/);
    expect(line).toBe('  n1{{"external x#34;#93;#59; click n1 #37;#37; #60;img#62; - Added"}}');
    expect(text).not.toMatch(/<|>|%%/);
  });
});

describe("escapeMermaidLabel", () => {
  it("keeps plain text, collapses whitespace, and encodes everything else", () => {
    expect(escapeMermaidLabel("GET /api/orders/:id")).toBe("GET /api/orders/:id");
    expect(escapeMermaidLabel("  a\t\n b  ")).toBe("a b");
    expect(escapeMermaidLabel('a"b#c')).toBe("a#34;b#35;c");
    expect(escapeMermaidLabel("café 🚀")).toBe("caf#233; #128640;");
  });

  it("cuts long labels at 60 code points", () => {
    expect(escapeMermaidLabel("a".repeat(61))).toBe(`${"a".repeat(57)}...`);
    expect(escapeMermaidLabel("a".repeat(60))).toBe("a".repeat(60));
  });
});
