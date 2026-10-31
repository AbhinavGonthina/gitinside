import { escapeMermaidLabel, mermaidShape } from "@gitinside/diff";
import type { Confidence } from "@gitinside/schema";
import { edgeLabel, edgeLabelText } from "../edges/describe.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import { drawnEdge, type GraphView } from "../model/view.js";
import { nodeLabel } from "../nodes/describe.js";

/**
 * The view on screen as a Mermaid `flowchart` (UX.md "Export", M4b.10): what
 * the canvas draws at its current level, for pasting into a README, an issue,
 * or a design doc.
 *
 * - **Nodes:** every visible node, a shape per kind (the diff's
 *   `mermaidShape`: routes and pages as stadiums, models and datastores as
 *   cylinders, queues as subroutines, outside APIs as hexagons). A node that's
 *   broken down is a `subgraph` around what's drawn inside it.
 * - **Lines:** one per drawn line, labelled as on the canvas ("POST
 *   /api/orders", "22 calls"); exact and pattern matches solid (`-->`),
 *   heuristic and unresolved ones dotted (`-.->`).
 * - **Same view ⇒ same text.** IDs are `n<i>` in the view's drawing order.
 * - **Untrusted text:** every label (and the repo name in the heading
 *   comment) goes through `escapeMermaidLabel`, so it can't close its quotes,
 *   start a directive, or carry HTML (SECURITY.md T10).
 * - **Not drawn:** the canvas's selection, trace, and zoom; Mermaid lays the
 *   diagram out itself, so positions differ from the canvas.
 */

const ARROW: Readonly<Record<Confidence, string>> = {
  exact: "-->",
  pattern: "-->",
  heuristic: "-.->",
  unresolved: "-.->",
};

/** A node's name as one line of text, method first for a route. */
function plainLabel(label: ReturnType<typeof nodeLabel>): string {
  return [label.method, label.text, label.code].filter(Boolean).join(" ");
}

/** The view as Mermaid flowchart text, ending in a newline. */
export function viewMermaid(index: HierarchyIndex, view: GraphView): string {
  const { owner, name, sha } = index.graph.repo;
  const ids = new Map(view.nodes.map((n, i) => [n.id, `n${i}`]));
  const at = sha ? ` at ${sha.slice(0, 7)}` : "";
  const out = [
    `%% ${escapeMermaidLabel(`${owner}/${name}${at}`)}, drawn by GitInside from the code`,
    "flowchart LR",
  ];

  const write = (parent: string, depth: number) => {
    const pad = "  ".repeat(depth);
    for (const id of view.childrenOf.get(parent) ?? []) {
      const n = view.byId.get(id);
      const ref = ids.get(id);
      if (!n || !ref) continue;
      const text = escapeMermaidLabel(plainLabel(nodeLabel(n.node)));
      if (n.open) {
        out.push(`${pad}subgraph ${ref} ["${text}"]`);
        write(id, depth + 1);
        out.push(`${pad}end`);
      } else {
        const [open, close] = mermaidShape(n.node.kind);
        out.push(`${pad}${ref}${open}"${text}"${close}`);
      }
    }
  };
  write(index.root.id, 1);

  for (const e of view.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    const { edge, count } = drawnEdge(e);
    const text = escapeMermaidLabel(edgeLabelText(edgeLabel(edge, count)));
    out.push(`  ${from} ${ARROW[e.confidence]}|"${text}"| ${to}`);
  }
  return `${out.join("\n")}\n`;
}
