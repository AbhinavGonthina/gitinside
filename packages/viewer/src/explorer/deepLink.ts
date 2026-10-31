import { compareStrings } from "@gitinside/schema";
import type { EdgeKind } from "@gitinside/schema";
import {
  CONFIDENCE_ORDER,
  DEFAULT_FILTERS,
  EDGE_KIND_ORDER,
  FILTER_KINDS,
  filterOptions,
  LAYER_ORDER,
  normalizeFilters,
  normalizeFolder,
  type Filters,
} from "../model/filters.js";
import { canOpen, type HierarchyIndex } from "../model/hierarchy.js";
import { DEFAULT_HIDDEN_KINDS } from "../model/view.js";
import type { Expansion } from "./drill.js";
import { canTraceFrom, traceFrom } from "./trace.js";

/**
 * What a deep link restores (M4b.9, UX.md "Deep links"): the explorer's
 * drill-down, selection, trace, and filters. The repo and commit are the
 * page's path, not part of it; the camera and the player's play/pause aren't
 * kept.
 */
export interface ExplorerState {
  /** Nodes broken down, in opening order (Esc closes the last one first). */
  open: Expansion;
  selected: string | null;
  /** The page or route being traced, or null when not tracing. */
  trace: string | null;
  /** The trace's current step, 0-based; null when not tracing. */
  step: number | null;
  filters: Filters;
  /** Connection kinds left off, sorted. */
  hiddenKinds: readonly EdgeKind[];
}

/** The explorer as it opens: the system level, nothing selected or traced, the default filters. */
export const DEFAULT_STATE: ExplorerState = {
  open: [],
  selected: null,
  trace: null,
  step: null,
  filters: DEFAULT_FILTERS,
  hiddenKinds: [...DEFAULT_HIDDEN_KINDS].sort(compareStrings),
};

/** A part of a link that {@link decodeState} left out, with what it said. */
export interface IgnoredParam {
  param: string;
  value: string;
}

/** A decoded link: the state to open with, and what in the link doesn't apply to this graph. */
export interface DecodedState {
  state: ExplorerState;
  ignored: IgnoredParam[];
}

/**
 * The query parameters, in the order {@link encodeState} writes them. Lists
 * are comma-separated; filters name what's left off (`hide…`), or the one
 * folder shown (`only`), and `tests=shown` turns off "Hide tests and config".
 */
export const STATE_PARAMS = [
  "open",
  "sel",
  "trace",
  "step",
  "hideLayers",
  "hideKinds",
  "hideConfidence",
  "hideLines",
  "only",
  "hideFolders",
  "tests",
] as const;

/**
 * A query value: percent-encoded (`,` too, so it can separate list items),
 * but with `/`, `:`, and `@` kept as they are, so node IDs stay readable
 * (`route:api/POST%20/api/orders`).
 */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%(2F|3A|40)/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A state as a URL query, without the leading `?`; empty for
 * {@link DEFAULT_STATE}. Only what differs from the default is written, in
 * {@link STATE_PARAMS} order, with the filters in canonical form, so equal
 * states give equal strings. A trace's step is written 1-based, as the
 * player shows it, and left out on the first step.
 */
export function encodeState(state: ExplorerState): string {
  const parts: string[] = [];
  const put = (param: string, values: readonly string[]) =>
    parts.push(`${param}=${values.map(encodeValue).join(",")}`);
  if (state.open.length > 0) put("open", state.open);
  if (state.selected !== null) put("sel", [state.selected]);
  if (state.trace !== null) {
    put("trace", [state.trace]);
    if (state.step !== null && state.step > 0) put("step", [String(state.step + 1)]);
  }
  const f = normalizeFilters(state.filters);
  if (f.layers.length > 0) put("hideLayers", f.layers);
  if (f.kinds.length > 0) put("hideKinds", f.kinds);
  if (f.confidence.length > 0) put("hideConfidence", f.confidence);
  const lines = [...new Set(state.hiddenKinds)].sort(compareStrings);
  if (!sameList(lines, DEFAULT_STATE.hiddenKinds)) put("hideLines", lines);
  if (f.include.length > 0) put("only", f.include);
  if (f.exclude.length > 0) put("hideFolders", f.exclude);
  if (!f.hideTestsAndConfig) put("tests", ["shown"]);
  return parts.join("&");
}

/** A page URL (no query) with a state's query from {@link encodeState}; just the page for the default state. */
export function withState(page: string, query: string): string {
  return query === "" ? page : `${page}?${query}`;
}

/** A query's parameters as raw value lists (the last of a repeated one wins); `+` reads as a space, like a form. */
function parseQuery(query: string): Map<string, string[] | undefined> {
  const params = new Map<string, string[] | undefined>();
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return undefined; // a malformed escape
    }
  };
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = decode(at < 0 ? pair : pair.slice(0, at));
    if (key === undefined) continue;
    const raw = at < 0 ? "" : pair.slice(at + 1);
    const values = raw === "" ? [] : raw.split(",").map(decode);
    params.set(key, values.every((v) => v !== undefined) ? (values as string[]) : undefined);
  }
  return params;
}

/**
 * Reads a URL query (with or without `?`) into an explorer state for one
 * graph. Nothing in a link is trusted: a node that isn't in the graph (or
 * can't be broken down, selected, or traced), a step past the trace's end,
 * an unknown layer, kind, confidence, or connection kind, a folder the repo
 * doesn't have, or a malformed value is left out and listed in `ignored`,
 * so the page can say the link doesn't fully apply to this commit. Missing
 * parameters keep {@link DEFAULT_STATE}'s values; parameters it doesn't
 * know (e.g. `utm_source`) are skipped without a note.
 */
export function decodeState(query: string, index: HierarchyIndex): DecodedState {
  const params = parseQuery(query);
  const ignored: IgnoredParam[] = [];
  const raw = (param: string) => params.get(param);
  /** A parameter's values: `undefined` when absent; a malformed one is noted and dropped. */
  const values = (param: string): string[] | undefined => {
    if (!params.has(param)) return undefined;
    const vs = raw(param);
    if (vs === undefined) ignored.push({ param, value: "(malformed)" });
    return vs ?? [];
  };
  /** The values passing `ok`, sorted and deduplicated; the rest noted. */
  const keep = <T extends string>(param: string, ok: (v: string) => boolean): T[] | undefined => {
    const vs = values(param);
    if (vs === undefined) return undefined;
    const out = new Set<T>();
    for (const v of vs) {
      if (ok(v)) out.add(v as T);
      else ignored.push({ param, value: v });
    }
    return [...out].sort(compareStrings);
  };
  /** A single-valued parameter: its value, or `undefined` (absent or noted). */
  const one = (param: string): string | undefined => {
    const vs = values(param);
    if (vs === undefined || vs.length === 0) return undefined;
    if (vs.length === 1) return vs[0];
    ignored.push({ param, value: vs.join(",") });
    return undefined;
  };

  const open: string[] = [];
  for (const id of values("open") ?? []) {
    if (index.byId.has(id) && canOpen(index, id)) {
      if (!open.includes(id)) open.push(id);
    } else ignored.push({ param: "open", value: id });
  }

  const sel = one("sel");
  let selected: string | null = null;
  if (sel !== undefined) {
    if (index.byId.has(sel) && sel !== index.root.id) selected = sel;
    else ignored.push({ param: "sel", value: sel });
  }

  const start = one("trace");
  let trace: string | null = null;
  if (start !== undefined) {
    const node = index.byId.get(start);
    if (node && canTraceFrom(index, node)) trace = start;
    else ignored.push({ param: "trace", value: start });
  }
  const stepText = one("step");
  let step: number | null = trace === null ? null : 0;
  if (stepText !== undefined) {
    const n = /^[1-9]\d*$/.test(stepText) ? Number(stepText) : NaN;
    if (trace !== null && n <= traceFrom(index, trace).steps.length) step = n - 1;
    else ignored.push({ param: "step", value: stepText });
  }

  const folders = new Set(filterOptions(index).folders);
  const isFolder = (v: string) => folders.has(normalizeFolder(v));
  const has = (list: readonly string[]) => (v: string) => list.includes(v);
  const layers = keep<Filters["layers"][number]>("hideLayers", has(LAYER_ORDER));
  const kinds = keep<Filters["kinds"][number]>("hideKinds", has(FILTER_KINDS));
  const confidence = keep<Filters["confidence"][number]>("hideConfidence", has(CONFIDENCE_ORDER));
  const lines = keep<EdgeKind>("hideLines", has(EDGE_KIND_ORDER));
  const include = keep("only", isFolder);
  const exclude = keep("hideFolders", isFolder);
  const tests = one("tests");
  if (tests !== undefined && tests !== "shown") ignored.push({ param: "tests", value: tests });

  const filters = normalizeFilters({
    layers: layers ?? DEFAULT_FILTERS.layers,
    kinds: kinds ?? DEFAULT_FILTERS.kinds,
    confidence: confidence ?? DEFAULT_FILTERS.confidence,
    include: include ?? DEFAULT_FILTERS.include,
    exclude: exclude ?? DEFAULT_FILTERS.exclude,
    hideTestsAndConfig: tests === "shown" ? false : DEFAULT_FILTERS.hideTestsAndConfig,
  });
  return {
    state: {
      open,
      selected,
      trace,
      step,
      filters,
      hiddenKinds: lines ?? DEFAULT_STATE.hiddenKinds,
    },
    ignored,
  };
}
