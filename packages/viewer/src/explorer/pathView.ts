import { isEntryGroup } from "../model/groups.js";
import { ancestry, canOpen, type HierarchyIndex } from "../model/hierarchy.js";
import { asServiceEntry, type Expansion } from "./drill.js";
import type { Trace } from "./trace.js";

/**
 * A trace started at the system level opens its path (M10.3d2, M10-design B1): each service the
 * path passes through breaks down just far enough for each hop's two ends to be separate boxes,
 * and inside those frames only the path's boxes are drawn (`ViewOptions.only`, `pathKeep`), the
 * rest counted as "+ N more" at the frame's foot.
 */

/**
 * The box that draws `id` when `open` (nodes really open) are broken down, as `buildView` places
 * it: the outermost closed node on its way down from the root, or `id` itself once it's an entry
 * at its open service's first level. Undefined when the filters hide it.
 */
export function holderIn(
  index: HierarchyIndex,
  open: ReadonlySet<string>,
  id: string,
  filtered: ReadonlySet<string> = new Set(),
): string | undefined {
  const target = index.byId.get(id);
  if (!target || filtered.has(id)) return undefined;
  const asEntry = asServiceEntry(index, open, target);
  const chain = ancestry(index, id).reverse().slice(1);
  for (const n of chain) {
    if (filtered.has(n.id)) return undefined;
    if (!open.has(n.id)) return asEntry ? id : n.id;
  }
  return chain.length > 0 ? id : undefined;
}

/**
 * What a trace opens (B1's rule): for each hop in order, while its two ends share one box, that
 * box breaks down, so the hop is drawn as a line between two boxes. Only frames (services, groups,
 * folders) break down: a file stays a card, so a hop between two functions of one file happens
 * inside it, as at any card (on taxonomy, opening `use-toast.ts` for its inner calls widened the
 * frame the first hop crosses, framing it at 45%). A hop inside one node opens nothing. Outermost
 * first, in the order they open.
 */
export function openForPath(
  index: HierarchyIndex,
  trace: Trace,
  filtered: ReadonlySet<string> = new Set(),
): Expansion {
  const open = new Set<string>();
  const order: string[] = [];
  const add = (id: string) => {
    open.add(id);
    order.push(id);
  };
  for (const step of trace.steps) {
    for (;;) {
      const from = holderIn(index, open, step.from.id, filtered);
      const to = holderIn(index, open, step.to.id, filtered);
      if (from === undefined || to === undefined) break;
      // A route or page group (M10.3d3) holding an end opens, so the path's route is drawn.
      const group = [from, to].find((id) => isEntryGroup({ id }) && canOpen(index, id));
      if (group !== undefined) {
        add(group);
        continue;
      }
      if (from !== to || !canOpen(index, from)) break;
      const kind = index.byId.get(from)?.kind;
      if (kind === "file" || kind === "symbol") break;
      add(from);
    }
  }
  return order;
}
