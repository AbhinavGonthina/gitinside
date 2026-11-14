import { compareStrings } from "@gitinside/schema";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Rect } from "../chrome/describe.js";
import { DiagramEdge, EdgeLabel } from "../edges/DiagramEdge.js";
import { BANDS, type PlacedEdge } from "../layout/elk.js";
import type { LayoutCache } from "../layout/engine.js";
import { changeCounts, frameCounts, viewCardLook, viewEdgeLabelSize } from "../layout/size.js";
import type { DiffCounts, DiffMarks } from "../model/diff.js";
import { layerOf, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import {
  drawnEdge,
  edgeWithin,
  type GraphView,
  type ViewEdge,
  type ViewNode,
} from "../model/view.js";
import { prefersReducedMotion } from "../motion.js";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { nodeTier, type NodeDiff, type NodeEmphasis } from "../nodes/describe.js";
import { durations, scaleTokens } from "../tokens.js";
import { ARROW_KEYS, nearestBox, type Direction } from "./a11y.js";
import { cull, CULL_FROM, cullWindow } from "./cull.js";
import { detailAt, insideOneService, markScale, serviceNameScale } from "./detail.js";
import { planTransition, type BoxExit, type Shown, type TransitionPlan } from "./transition.js";

/**
 * How a box looks besides its node: selected, its part in a trace, and in
 * diff mode its own state, the changes inside it (badges while closed), or
 * that it isn't in the version shown (kept in place, not drawn).
 */
export interface BoxLook {
  selected?: boolean | undefined;
  emphasis?: NodeEmphasis | undefined;
  diff?: NodeDiff | undefined;
  changes?: Readonly<DiffCounts> | undefined;
  absent?: boolean | undefined;
}

/**
 * How a line and its pill look: selected, its part in a trace, particles
 * flowing along it, the current hop's pulse (which way the request goes
 * along the drawn line), and in diff mode its state, what broke, or that it
 * isn't in the version shown.
 */
export interface LineLook {
  selected?: boolean | undefined;
  emphasis?: NodeEmphasis | undefined;
  flow?: boolean | undefined;
  pulse?: "forward" | "backward" | undefined;
  diff?: NodeDiff | undefined;
  broken?: string | undefined;
  absent?: boolean | undefined;
}

/** Props for {@link DrillCanvas}. */
export interface DrillCanvasProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> {
  index: HierarchyIndex;
  /** The view to draw (from `useDrill` or `buildView`). */
  view: GraphView;
  /**
   * Layouts of `index`'s views, one cache for the graph's life. Undefined
   * until the host's layout engine has started: the level stays pending.
   */
  cache: Pick<LayoutCache, "layout" | "peek"> | undefined;
  /** Asked to break a node down (double-click or Enter on a box that can open). */
  onOpen?: ((id: string) => void) | undefined;
  /** Asked to select a box (click, Space, or Enter on a box that can't open further). */
  onSelect?: ((id: string) => void) | undefined;
  /** Each drawn box's look. */
  boxLook?: ((n: ViewNode) => BoxLook) | undefined;
  /** Each drawn line's (and its pill's) look. */
  lineLook?: ((e: ViewEdge) => LineLook) | undefined;
  /** Called each time a view is drawn, with its layout. */
  onLayout?: ((shown: Shown) => void) | undefined;
  /** The host camera's zoom, which sets how much text is drawn (`detail.ts`; default 1). */
  zoom?: number | undefined;
  /**
   * The part of the stage on screen (`visibleRect`, stage coordinates; while
   * the host's camera glides, all it passes over: `useGlideSpan`). With it, a
   * big level draws only what's near it (`cull.ts`); without, everything.
   */
  viewport?: Rect | undefined;
  /** Boxes drawn wherever they are, because the host may focus them (the selection, a trace's start). */
  keep?: readonly string[] | undefined;
  /** How many boxes and lines a level needs before it's culled (default {@link CULL_FROM}). */
  cullFrom?: number | undefined;
  /** Diff mode's marks, which `cache` sized the boxes and pills with (`createLayoutCache`). */
  marks?: DiffMarks | undefined;
  /**
   * Diff mode's Base or Head: that version's hierarchy on `index`'s IDs
   * (`versionGraph`). Boxes draw its records (a renamed node's base name in
   * Base) and counts, lines and pills only its connections (M6.9c2); places
   * stay the layout's. What it lacks fades out as the overlay drew it.
   */
  versionIndex?: HierarchyIndex | undefined;
  /**
   * Draw the prototype's cards (M10.3b3, `cardLook`), which `cache` must have sized
   * (`LayoutInputOptions.cards`): names wrap, services carry a count row and role.
   */
  cards?: boolean | undefined;
}

/**
 * Boxes leaving the canvas, kept for their fold, and where each moving box's
 * glide starts (so culling keeps it until it has slid out). `generation`
 * tells one transition's from the next's.
 */
interface Leaving {
  generation: number;
  boxes: readonly BoxExit[];
  from: ReadonlyMap<string, Rect>;
}

const NO_GLIDES: ReadonlyMap<string, Rect> = new Map();
const NO_SIBLINGS: readonly string[] = [];

/** What a box does on a click, double-click, or key, read when it happens (so boxes needn't re-render when it changes). */
interface BoxActions {
  select: ((id: string) => void) | undefined;
  open: (n: ViewNode) => void;
  keyDown: (event: KeyboardEvent<HTMLElement>, n: ViewNode) => void;
}

interface CanvasBoxProps {
  index: HierarchyIndex;
  /** The version shown, when it isn't the overlay (`DrillCanvasProps.versionIndex`). */
  shown: HierarchyIndex | undefined;
  n: ViewNode;
  rect: Rect;
  leaving: boolean;
  /** The IDs drawn beside it under the same parent, for its place in the tree. */
  siblings: readonly string[];
  selected: boolean;
  emphasis: NodeEmphasis | undefined;
  diff: NodeDiff | undefined;
  changes: Readonly<DiffCounts> | undefined;
  absent: boolean;
  selectable: boolean;
  actions: RefObject<BoxActions>;
  register: (id: string, leaving: boolean, el: HTMLElement | null) => void;
  /** The prototype's cards (`DrillCanvasProps.cards`). */
  cards: boolean;
}

/**
 * One box, memoized: a camera move re-renders the canvas (its zoom sets the
 * detail level), but a box whose node, place, and look are unchanged isn't
 * drawn again. Its handlers read `actions` when they fire.
 *
 * As an item of the canvas's tree (WAI-ARIA `treeitem`) it carries its depth
 * and place among its siblings (the boxes aren't nested in the DOM, so these
 * give the tree its shape), broken down or not when it can be, and selected
 * or not. A box folding away is hidden instead.
 */
const CanvasBox = memo(function CanvasBox({
  index,
  shown,
  n,
  rect,
  leaving,
  siblings,
  selected,
  emphasis,
  diff,
  changes,
  absent,
  selectable,
  actions,
  register,
  cards,
}: CanvasBoxProps) {
  const frame = nodeTier(n.node) === "frame";
  const ref = useCallback(
    (el: HTMLElement | null) => register(n.id, leaving, el),
    [register, n.id, leaving],
  );
  // Out of the tree and the Tab order, like a box folding away.
  const hidden = leaving || absent;
  // A box the version lacks fades out as the overlay drew it.
  const from = shown && !absent ? shown : index;
  const node = from.byId.get(n.id) ?? n.node;
  const card = cards ? viewCardLook(from, { ...n, node }) : undefined;
  const counts = n.open
    ? []
    : [...(card?.counts ?? (frame ? frameCounts(from, n.id) : [])), ...changeCounts(changes)];
  const tree = hidden
    ? {}
    : {
        role: "treeitem",
        "aria-level": n.level + 1,
        "aria-setsize": siblings.length,
        "aria-posinset": siblings.indexOf(n.id) + 1,
        "aria-expanded": n.open || n.canOpen ? n.open : undefined,
        "aria-selected": selected,
      };
  return (
    <div
      ref={ref}
      className="gi-drill__node"
      data-node-id={n.id}
      data-open={n.open ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      data-absent={absent ? "" : undefined}
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <DiagramNode
        {...tree}
        node={node}
        layer={layerOf(index, n.id)}
        counts={counts}
        scope={from.scopes.get(n.id)}
        card={card}
        wrap={cards}
        expanded={n.open}
        selected={selected}
        emphasis={emphasis}
        diff={diff}
        tabIndex={hidden ? -1 : 0}
        data-can-open={n.canOpen && !n.open ? "" : undefined}
        onClick={
          hidden || !selectable
            ? undefined
            : (e) => {
                e.stopPropagation();
                actions.current.select?.(n.id);
              }
        }
        onDoubleClick={
          hidden
            ? undefined
            : (e) => {
                e.stopPropagation();
                actions.current.open(n);
              }
        }
        onKeyDown={hidden ? undefined : (e) => actions.current.keyDown(e, n)}
      />
    </div>
  );
});

interface CanvasLineProps extends LineLook {
  index: HierarchyIndex;
  /** The version shown, when it isn't the overlay (`DrillCanvasProps.versionIndex`). */
  shown: HierarchyIndex | undefined;
  /** Its edge IDs, which the line keeps of the connections it stands for. */
  keep: ReadonlySet<string> | undefined;
  e: ViewEdge;
  placed: PlacedEdge;
}

/**
 * The line as the version shown draws it, and its ends' names there. One it
 * lacks fades out as the overlay drew it.
 */
function lineIn({
  index,
  shown,
  keep,
  e,
  absent,
}: Pick<CanvasLineProps, "index" | "shown" | "keep" | "e" | "absent">) {
  const from = shown && !absent ? shown : index;
  const name = (id: string) => (from.byId.get(id) ?? nodeOf(index, id)).label;
  return {
    ...drawnEdge((keep && !absent && edgeWithin(e, keep)) || e),
    ends: { from: name(e.from), to: name(e.to) },
  };
}

/** One line, memoized like {@link CanvasBox}. A line not in the version shown is kept out of reach. */
const CanvasLine = memo(function CanvasLine({
  index,
  shown,
  keep,
  e,
  placed,
  selected,
  emphasis,
  flow,
  pulse,
  diff,
  broken,
  absent,
}: CanvasLineProps) {
  const { edge, count, ends } = lineIn({ index, shown, keep, e, absent });
  return (
    <DiagramEdge
      edge={edge}
      count={count}
      points={placed.points}
      markAt={placed.label}
      layer={layerOf(index, e.from)}
      ends={ends}
      selected={selected}
      emphasis={emphasis}
      diff={diff}
      broken={broken}
      flow={!absent && (flow ?? false)}
      pulse={absent ? undefined : pulse}
      data-inner={insideOneService(index, e) ? "" : undefined}
      data-absent={absent ? "" : undefined}
      aria-hidden={absent || undefined}
    />
  );
});

/** One line's pill, memoized like {@link CanvasBox}; `width` is what the layout made room for. */
const CanvasPill = memo(function CanvasPill({
  index,
  shown,
  keep,
  e,
  placed,
  selected,
  emphasis,
  diff,
  broken,
  absent,
  width,
}: Omit<CanvasLineProps, "flow" | "pulse"> & { width: number }) {
  const { edge, count } = lineIn({ index, shown, keep, e, absent });
  return (
    <EdgeLabel
      edge={edge}
      count={count}
      layer={layerOf(index, e.from)}
      selected={selected}
      emphasis={emphasis}
      diff={diff}
      broken={broken}
      data-measured-width={width}
      data-absent={absent ? "" : undefined}
      style={{ left: placed.label.x, top: placed.label.y }}
    />
  );
});

/** What the commit after a swap still has to do: play the plan, and put focus back. */
interface Pending {
  plan?: TransitionPlan;
  /** Nodes opened or closed by the swap, outermost first. */
  toggled: string[];
  /** Keyboard focus was on the canvas before the swap. */
  hadFocus: boolean;
}

/** Nodes open in one view and not the other, outermost first. */
export function toggledBetween(a: GraphView, b: GraphView): string[] {
  const inA = new Set(a.open);
  const inB = new Set(b.open);
  const ids = [...a.open.filter((id) => !inB.has(id)), ...b.open.filter((id) => !inA.has(id))];
  const level = (id: string) => b.byId.get(id)?.level ?? a.byId.get(id)?.level ?? 0;
  return ids.sort((x, y) => level(x) - level(y));
}

const px = (n: number) => `${n}px`;

/**
 * Glides an element placed at `base` from `from` to `to` (in the same
 * coordinates), fading from one opacity to another. Width and height move
 * too, so a frame grows around its children and text never stretches. A
 * leaving box keeps its end state (`fill`) until it's removed. No-op where
 * the Web Animations API is missing (jsdom, very old browsers).
 */
function glide(
  el: HTMLElement,
  base: Rect,
  from: Rect,
  to: Rect,
  opacity: [number, number],
  fill: FillMode = "none",
) {
  if (typeof el.animate !== "function") return;
  const frame = (r: Rect, o: number): Keyframe => ({
    transform: `translate(${px(r.x - base.x)}, ${px(r.y - base.y)})`,
    width: px(r.width),
    height: px(r.height),
    opacity: o,
  });
  el.animate([frame(from, opacity[0]), frame(to, opacity[1])], {
    duration: durations.layout,
    easing: scaleTokens["ease-layout"],
    fill,
  });
}

/** Fades the lines or pills in over the glide's second half, once the boxes are nearly in place. */
function fadeInAfter(el: Element | null) {
  if (!el || typeof el.animate !== "function") return;
  el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
    duration: durations.layout,
    easing: scaleTokens["ease-layout"],
  });
}

/**
 * The drill-down canvas (M4b.3, UX.md "Drill-down"): draws a view from its
 * ELK layout with the real node and edge components, and moves in place
 * when the view changes. A broken-down node grows into a frame while its
 * siblings glide aside and its children emerge from its center; a closed one
 * shrinks back while its children fold into it; the lines and pills fade in
 * as the boxes land. Never a whole-canvas re-render: until the next layout
 * is ready the current one stays (`aria-busy`), and a cached state swaps in
 * at once. A change mid-glide starts from where the boxes are drawn then.
 * Under reduced motion every change is instant.
 *
 * The host owns the state: double-click or Enter asks to open a box
 * (`onOpen`); a click, Space, or Enter on a box that can't open further asks
 * to select it (`onSelect`); `boxLook` and `lineLook` draw the selection and
 * a trace. Esc is the host's too. When opening or closing replaces the
 * focused box's element, focus goes to the toggled box. `data-layout` is
 * "pending" until the first layout is drawn.
 *
 * For keyboards and screen readers (M4b.11, ADR-0126) the boxes are a
 * WAI-ARIA tree: each is a `treeitem` with its level, place among its
 * siblings, `aria-expanded` when it can break down, and `aria-selected`.
 * Every box is a Tab stop, in drawing order (a frame, then its inside), and
 * an arrow key moves focus to the nearest box that way (`nearestBox`)
 * without scrolling; the host's camera follows focus.
 *
 * `zoom` thins the text out for a zoomed-out camera (`detail.ts`): the level
 * is drawn as `data-detail`, the service names' scale as `--gi-name-scale`,
 * and the diff glyphs' as `--gi-mark-scale`, with `data-inner` on each line
 * between two boxes of one service; `drill.css` fades and scales, so zooming
 * never resizes a box.
 *
 * For big levels (M4b.13a, ADR-0129), with the host's `viewport`, only the
 * boxes, lines, and pills near it are in the page (`cull.ts`); the focused
 * box, the host's `keep` boxes, an arrow key's target, and boxes gliding out
 * are drawn wherever they are. Boxes, lines, and pills are memoized, so a
 * camera move re-renders only what its look or the culling changed.
 */
export function DrillCanvas({
  index,
  view,
  cache,
  onOpen,
  onSelect,
  boxLook,
  lineLook,
  onLayout,
  zoom = 1,
  viewport,
  keep,
  cullFrom = CULL_FROM,
  marks,
  versionIndex,
  cards = false,
  className,
  style,
  ...rest
}: DrillCanvasProps) {
  const versionEdges = useMemo(
    () => versionIndex && new Set(versionIndex.graph.edges.map((e) => e.id)),
    [versionIndex],
  );
  const [shown, setShown] = useState<Shown | undefined>(() => {
    const layout = cache?.peek(view);
    return layout ? { view, layout } : undefined;
  });
  const [leaving, setLeaving] = useState<Leaving>({ generation: 0, boxes: [], from: NO_GLIDES });
  /** The box with focus, drawn wherever the camera goes so focus isn't lost to culling. */
  const [focused, setFocused] = useState<string | null>(null);
  /** A culled box an arrow key moved to: drawn, then focused. */
  const [stepTo, setStepTo] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const stageRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<SVGSVGElement>(null);
  const quietRef = useRef<SVGSVGElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const boxEls = useRef(new Map<string, HTMLElement>());
  const leavingEls = useRef(new Map<string, HTMLElement>());
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const pending = useRef<Pending | undefined>(undefined);
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  /**
   * Where each gliding box is drawn now, in stage coordinates, and stops its
   * glide (the next one starts from there). Boxes at rest aren't listed:
   * they're where their layout put them.
   */
  function stopGlides(): Map<string, Rect> {
    const now = new Map<string, Rect>();
    const stage = stageRef.current;
    if (!stage) return now;
    const origin = stage.getBoundingClientRect();
    const scale = stage.offsetWidth > 0 ? origin.width / stage.offsetWidth : 1;
    for (const [id, el] of boxEls.current) {
      const running = el.getAnimations?.() ?? [];
      if (running.length === 0) continue;
      const r = el.getBoundingClientRect();
      now.set(id, {
        x: (r.left - origin.left) / scale,
        y: (r.top - origin.top) / scale,
        width: r.width / scale,
        height: r.height / scale,
      });
      for (const a of running) a.cancel();
    }
    for (const el of [linesRef.current, quietRef.current, labelsRef.current]) {
      for (const a of el?.getAnimations?.() ?? []) a.cancel();
    }
    return now;
  }

  useEffect(() => {
    if (!cache) return;
    let live = true;
    const draw = (next: Shown) => {
      if (!live) return;
      const prev = shownRef.current;
      if (prev?.view === next.view && prev.layout === next.layout) return;
      setError(undefined);
      const stage = stageRef.current;
      const hadFocus = stage?.contains(document.activeElement) ?? false;
      const motion = prev !== undefined && !prefersReducedMotion();
      const plan = motion ? planTransition(index, prev, next, stopGlides()) : undefined;
      pending.current = {
        ...(plan ? { plan } : {}),
        toggled: prev ? toggledBetween(prev.view, next.view) : [],
        hadFocus,
      };
      setLeaving((l) => ({
        generation: l.generation + 1,
        boxes: plan?.exits ?? [],
        from: plan ? new Map(plan.moves.map((m) => [m.id, m.from])) : NO_GLIDES,
      }));
      setShown(next);
      onLayoutRef.current?.(next);
    };
    const hit = cache.peek(view);
    if (hit) draw({ view, layout: hit });
    else {
      cache.layout(view).then(
        (layout) => draw({ view, layout }),
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [index, view, cache]);

  // After a swap commits: play the glides, then drop the folded boxes; put
  // focus back on the toggled box if its element was replaced.
  useLayoutEffect(() => {
    const work = pending.current;
    pending.current = undefined;
    if (!work || !shown) return;
    const { plan, toggled, hadFocus } = work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (plan) {
      for (const m of plan.moves) {
        const el = boxEls.current.get(m.id);
        if (el) glide(el, m.to, m.from, m.to, [m.emerging ? 0 : 1, 1]);
      }
      const { generation, boxes, from } = leavingRef.current;
      for (const e of boxes) {
        const el = leavingEls.current.get(e.node.id);
        if (el) glide(el, e.from, e.from, e.to, [1, 0], "forwards");
      }
      fadeInAfter(linesRef.current);
      fadeInAfter(quietRef.current);
      fadeInAfter(labelsRef.current);
      if (boxes.length > 0 || from.size > 0) {
        timer = setTimeout(
          () =>
            setLeaving((l) =>
              l.generation === generation ? { generation, boxes: [], from: NO_GLIDES } : l,
            ),
          durations.layout,
        );
      }
    }
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (hadFocus && lost) {
      for (const id of toggled) {
        const target = boxEls.current.get(id)?.querySelector<HTMLElement>(":scope > .gi-node");
        if (target) {
          target.focus();
          break;
        }
      }
    }
    return () => clearTimeout(timer);
  }, [shown]);

  const drawn = shown?.view;
  const busy = shown !== undefined && drawn !== view;

  function open(n: ViewNode) {
    if (n.canOpen && !n.open) onOpen?.(n.id);
  }

  /** Moves focus to the box an arrow key points at, if any, without scrolling (the host's camera follows). */
  function step(from: string, direction: Direction) {
    const boxes = shownRef.current?.layout.boxes;
    const to = boxes ? nearestBox(boxes, from, direction) : undefined;
    if (to === undefined) return;
    const el = boxEls.current.get(to)?.querySelector<HTMLElement>(":scope > .gi-node");
    // A culled box has no element yet: draw it, then focus it (below).
    if (el) el.focus({ preventScroll: true });
    else setStepTo(to);
  }
  useLayoutEffect(() => {
    if (stepTo === null) return;
    setStepTo(null);
    boxEls.current
      .get(stepTo)
      ?.querySelector<HTMLElement>(":scope > .gi-node")
      ?.focus({ preventScroll: true });
  }, [stepTo]);

  /**
   * Enter breaks a box down, or selects one that can't open further (UX.md);
   * Space selects; an arrow key moves to the nearest box that way.
   */
  function onKeyDown(event: KeyboardEvent<HTMLElement>, n: ViewNode) {
    const direction = ARROW_KEYS[event.key];
    if (direction && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      // Kept from the page even at an edge, which would otherwise scroll.
      event.preventDefault();
      step(n.id, direction);
      return;
    }
    const opens = event.key === "Enter" && n.canOpen && !n.open && onOpen !== undefined;
    const selects = (event.key === "Enter" || event.key === " ") && !opens && onSelect;
    if (!opens && !selects) return;
    event.preventDefault();
    event.stopPropagation();
    if (opens) open(n);
    else onSelect?.(n.id);
  }

  const actions = useRef<BoxActions>({ select: onSelect, open, keyDown: onKeyDown });
  actions.current = { select: onSelect, open, keyDown: onKeyDown };
  const register = useCallback((id: string, leavingBox: boolean, el: HTMLElement | null) => {
    const map = leavingBox ? leavingEls.current : boxEls.current;
    if (el) map.set(id, el);
    else map.delete(id);
  }, []);

  /** Tracks the focused box, so culling keeps it drawn. */
  function onFocusChange(event: FocusEvent<HTMLElement>, entering: boolean) {
    const target = entering ? event.target : event.relatedTarget;
    const owner = target instanceof Element ? target.closest<HTMLElement>(".gi-drill__node") : null;
    const id = owner && !owner.hasAttribute("data-leaving") ? (owner.dataset.nodeId ?? null) : null;
    setFocused(id);
  }

  // What's drawn: on a big level only what's near the camera's view (cull.ts).
  const win = viewport ? cullWindow(viewport) : undefined;
  const winKey = win ? `${win.x},${win.y},${win.width},${win.height}` : "";
  const kept = [...(keep ?? []), ...(focused === null ? [] : [focused])];
  if (stepTo !== null) kept.push(stepTo);
  const keptKey = kept.sort(compareStrings).join("\n");
  const layout = shown?.layout;
  const culled = useMemo(
    () =>
      layout &&
      cull(layout, win, new Set(keptKey === "" ? [] : keptKey.split("\n")), leaving.from, cullFrom),
    // `win` and the kept IDs by value, so a camera move inside one tile keeps the same sets.
    [layout, winKey, keptKey, leaving.from, cullFrom],
  );
  const edges = useMemo(() => new Map((drawn?.edges ?? []).map((e) => [e.id, e])), [drawn]);
  // Each box's look, asked once per render (only for the boxes drawn, outside diff mode).
  const looks = new Map<string, BoxLook>();
  const lookOf = (n: ViewNode): BoxLook => {
    const known = looks.get(n.id);
    if (known) return known;
    const look = boxLook?.(n) ?? {};
    looks.set(n.id, look);
    return look;
  };
  // Boxes not in the version shown aren't in the tree, so their siblings' places skip them.
  const absentKey = marks
    ? (drawn?.nodes ?? []).flatMap((n) => (lookOf(n).absent ? [n.id] : [])).join("\n")
    : "";
  const siblings = useMemo(() => {
    if (absentKey === "" || !drawn) return drawn?.childrenOf;
    const absent = new Set(absentKey.split("\n"));
    return new Map(
      [...drawn.childrenOf].map(([id, kids]) => [id, kids.filter((k) => !absent.has(k))]),
    );
  }, [drawn, absentKey]);
  const siblingsOf = (n: ViewNode) => siblings?.get(n.parent ?? index.root.id) ?? NO_SIBLINGS;
  /** One line of the layout, if it's drawn: in the quiet layer behind the boxes (`quiet`), or above them. */
  const line = (placed: PlacedEdge, quiet: boolean) => {
    const e = edges.get(placed.id);
    if (!e || !culled?.edges.has(placed.id) || (placed.quiet ?? false) !== quiet) return null;
    const { selected, emphasis, flow, pulse, diff, broken, absent } = lineLook?.(e) ?? {};
    return (
      <CanvasLine
        key={placed.id}
        index={index}
        shown={versionIndex}
        keep={versionEdges}
        e={e}
        placed={placed}
        selected={selected}
        emphasis={emphasis}
        flow={flow}
        pulse={pulse}
        diff={diff}
        broken={broken}
        absent={absent}
      />
    );
  };
  const quietLines = shown?.layout.edges.some((p) => p.quiet) ?? false;
  return (
    <div
      {...rest}
      className={className ? `gi-drill ${className}` : "gi-drill"}
      style={
        {
          ...style,
          "--gi-name-scale": serviceNameScale(zoom),
          "--gi-mark-scale": markScale(zoom),
        } as CSSProperties
      }
      data-layout={shown ? "done" : "pending"}
      data-detail={detailAt(zoom)}
      aria-busy={busy || !shown || undefined}
    >
      {error && <p role="alert">Couldn&apos;t lay out this level: {error}</p>}
      {shown && drawn && (
        <div
          ref={stageRef}
          className="gi-drill__stage"
          style={{ width: shown.layout.width, height: shown.layout.height }}
        >
          {shown.layout.bands && (
            <div className="gi-drill__bands" aria-hidden="true">
              {shown.layout.bands.map(({ band, x }) => (
                <span key={band} className="gi-drill__band" style={{ left: x }}>
                  {BANDS[band]?.label}
                </span>
              ))}
            </div>
          )}
          {quietLines && (
            <svg
              ref={quietRef}
              className="gi-drill__lines"
              data-quiet=""
              width={shown.layout.width}
              height={shown.layout.height}
              role="group"
              aria-label="Code dependencies"
            >
              {shown.layout.edges.map((placed) => line(placed, true))}
            </svg>
          )}
          <div
            className="gi-drill__boxes"
            role="tree"
            aria-label="Architecture"
            onFocus={(e) => onFocusChange(e, true)}
            onBlur={(e) => onFocusChange(e, false)}
          >
            {leaving.boxes.map((e) => (
              <CanvasBox
                key={`leaving:${e.node.id}`}
                index={index}
                shown={versionIndex}
                n={e.node}
                rect={e.from}
                leaving
                siblings={NO_SIBLINGS}
                selected={false}
                emphasis={undefined}
                diff={undefined}
                changes={undefined}
                absent={false}
                selectable={false}
                actions={actions}
                register={register}
                cards={cards}
              />
            ))}
            {/* One stable list in drawing order, so Tab reads a frame, then its inside. */}
            {shown.layout.boxes.map((b) => {
              const n = drawn.byId.get(b.id);
              if (!n || !culled?.boxes.has(b.id)) return null;
              const look = lookOf(n);
              return (
                <CanvasBox
                  key={n.id}
                  index={index}
                  shown={versionIndex}
                  n={n}
                  rect={b}
                  leaving={false}
                  siblings={siblingsOf(n)}
                  selected={look.selected ?? false}
                  emphasis={look.emphasis}
                  diff={look.diff}
                  changes={look.changes}
                  absent={look.absent ?? false}
                  selectable={onSelect !== undefined}
                  actions={actions}
                  register={register}
                  cards={cards}
                />
              );
            })}
          </div>
          <svg
            ref={linesRef}
            className="gi-drill__lines"
            width={shown.layout.width}
            height={shown.layout.height}
            role="group"
            aria-label="Connections"
          >
            {shown.layout.edges.map((placed) => line(placed, false))}
          </svg>
          <div ref={labelsRef} className="gi-drill__labels">
            {shown.layout.edges.map((placed) => {
              const e = edges.get(placed.id);
              if (!e || !culled?.edges.has(placed.id)) return null;
              const { selected, emphasis, diff, broken, absent } = lineLook?.(e) ?? {};
              // A quiet line's pill shows only on a trace's path: the layout kept it no room, and a
              // selected box's code lines all start at one point, so their pills would pile up.
              if (placed.quiet && emphasis !== "current" && emphasis !== "traced") return null;
              return (
                <CanvasPill
                  key={placed.id}
                  index={index}
                  shown={versionIndex}
                  keep={versionEdges}
                  e={e}
                  placed={placed}
                  selected={selected}
                  emphasis={emphasis}
                  diff={diff}
                  broken={broken}
                  absent={absent}
                  width={viewEdgeLabelSize(e, marks).width}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
