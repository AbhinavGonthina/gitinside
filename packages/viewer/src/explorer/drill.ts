import { compareStrings } from "@gitinside/schema";
import { useMemo, useState } from "react";
import { canOpen, isWithin, type HierarchyIndex } from "../model/hierarchy.js";
import { buildView, effectiveOpen, type GraphView, type ViewOptions } from "../model/view.js";

/**
 * The explorer's drill-down state (M4b.3, UX.md "Drill-down"): which nodes
 * are broken down, in the order they were opened, most recent last. The view
 * model (`buildView`) only needs the set; the order is what makes Esc close
 * the level opened last. A node remembered inside a closed one stays in the
 * list, so reopening its parent restores it (ADR-0105).
 */
export type Expansion = readonly string[];

/** Breaks a node down: appended, or moved to the end if it was opened before. A node with nothing inside is ignored. */
export function openIn(index: HierarchyIndex, expansion: Expansion, id: string): Expansion {
  if (!canOpen(index, id)) return expansion;
  return [...expansion.filter((x) => x !== id), id];
}

/** Closes a node. What was opened inside it is remembered for when it opens again. */
export function closeIn(expansion: Expansion, id: string): Expansion {
  return expansion.includes(id) ? expansion.filter((x) => x !== id) : expansion;
}

/**
 * Going up a level (Esc): closes the most recently opened node that is on
 * the canvas now, skipping ones remembered inside a closed node. `closed` is
 * unset when nothing is open (the system level).
 */
export function upFrom(
  index: HierarchyIndex,
  expansion: Expansion,
): { expansion: Expansion; closed?: string } {
  const open = effectiveOpen(index, expansion);
  for (let i = expansion.length - 1; i >= 0; i--) {
    const id = expansion[i];
    if (id !== undefined && open.has(id)) {
      return { expansion: expansion.filter((_, j) => j !== i), closed: id };
    }
  }
  return { expansion };
}

/**
 * A breadcrumb: back to `id`'s level. Everything opened inside it closes
 * and is forgotten; `id` itself stays as it is. The root closes everything.
 */
export function collapseTo(index: HierarchyIndex, expansion: Expansion, id: string): Expansion {
  return expansion.filter((x) => x === id || !isWithin(index, x, id));
}

/** The drill-down state with its view, from {@link useDrill}. */
export interface Drill {
  expansion: Expansion;
  /** The view for the expansion; the same object until the open nodes change. */
  view: GraphView;
  open(id: string): void;
  close(id: string): void;
  /** Goes up a level; returns the node it closed, if any (for the announcement). */
  up(): string | undefined;
  collapseTo(id: string): void;
}

/**
 * Holds a drill-down state for one graph and builds its view. `initial` is
 * read once; pass a stable `hiddenKinds` set (a new one rebuilds the view).
 */
export function useDrill(
  index: HierarchyIndex,
  initial: Expansion = [],
  options?: ViewOptions,
): Drill {
  const [expansion, setExpansion] = useState(initial);
  // Keyed by the open set, not the list: reordering or a remembered node
  // doesn't change what's drawn, so the canvas sees the same view
  // (`expansion` is read for the open set `openKey` stands for).
  const openKey = JSON.stringify([...effectiveOpen(index, expansion)].sort(compareStrings));
  const hiddenKinds = options?.hiddenKinds;
  const view = useMemo(
    () => buildView(index, expansion, hiddenKinds ? { hiddenKinds } : {}),
    [index, openKey, hiddenKinds],
  );
  return {
    expansion,
    view,
    open: (id) => setExpansion((e) => openIn(index, e, id)),
    close: (id) => setExpansion((e) => closeIn(e, id)),
    up() {
      const { expansion: next, closed } = upFrom(index, expansion);
      if (closed !== undefined) setExpansion(next);
      return closed;
    },
    collapseTo: (id) => setExpansion((e) => collapseTo(index, e, id)),
  };
}
