import { compareStrings } from "@gitinside/schema";
import { useMemo, useState } from "react";
import { CommandPalette, type PaletteResult } from "../chrome/CommandPalette.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { canTraceFrom } from "./trace.js";

/**
 * The trace picker (M4b.6b, UX.md "Trace mode"): what T and the Trace button
 * open when nothing traceable is selected. It lists every page and route with
 * a request path, searchable by name and file; Enter or a click traces it.
 */

/** A page or route the picker offers, with the text a query is matched against. */
export interface TraceChoice {
  result: PaletteResult;
  /** The name and file, lowercased. */
  haystack: string;
}

/** Every page and route with a request path: pages first (requests start there), then by name and ID. */
export function traceChoices(index: HierarchyIndex): TraceChoice[] {
  return index.graph.nodes
    .filter((n) => canTraceFrom(index, n))
    .sort(
      (a, b) =>
        compareStrings(a.kind, b.kind) ||
        compareStrings(a.label, b.label) ||
        compareStrings(a.id, b.id),
    )
    .map((node) => {
      const path = "source" in node ? node.source?.file : undefined;
      return {
        result: { node, layer: layerOf(index, node.id), path },
        haystack: `${node.label} ${path ?? ""}`.toLowerCase(),
      };
    });
}

/**
 * The choices matching `query`: every word in it appears in the name or the
 * file, in any case. The name's first occurrence of each word is marked.
 * An empty query keeps them all.
 */
export function filterChoices(choices: readonly TraceChoice[], query: string): PaletteResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: PaletteResult[] = [];
  for (const { result, haystack } of choices) {
    if (!words.every((w) => haystack.includes(w))) continue;
    const name = result.node.label.toLowerCase();
    const matches = words.flatMap((w) => {
      const at = name.indexOf(w);
      return at < 0 ? [] : [[at, at + w.length] as const];
    });
    out.push(matches.length > 0 ? { ...result, matches } : result);
  }
  return out;
}

/** Props for {@link TracePicker}. */
export interface TracePickerProps {
  choices: readonly TraceChoice[];
  /** `"closing"` while it plays its exit (`usePresence`). */
  state: "open" | "closing";
  onPick: (id: string) => void;
  onClose: () => void;
  /** Nodes the filters hide, marked in the list (tracing one shows it). */
  hidden?: ReadonlySet<string> | undefined;
}

/** The picker dialog: the palette's shell, holding its own query and active row. */
export function TracePicker({ choices, state, onPick, onClose, hidden }: TracePickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterChoices(choices, query), [choices, query]);
  return (
    <CommandPalette
      label="Trace a request"
      placeholder="Trace from a page or route"
      pickVerb="trace"
      autoFocus
      hidden={hidden}
      state={state}
      query={query}
      results={results}
      activeIndex={active}
      onQueryChange={(q) => {
        setQuery(q);
        setActive(0);
      }}
      onActiveIndexChange={setActive}
      onPick={onPick}
      onClose={onClose}
      empty={
        choices.length === 0
          ? "No page or route in this repo has a request path to trace."
          : query
            ? `No page or route matches “${query}”.`
            : undefined
      }
    />
  );
}
