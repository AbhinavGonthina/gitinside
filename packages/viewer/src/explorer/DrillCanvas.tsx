import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
} from "react";
import type { Rect } from "../chrome/describe.js";
import { DiagramEdge, EdgeLabel } from "../edges/DiagramEdge.js";
import type { LayoutCache } from "../layout/engine.js";
import { edgeLabelSize, frameCounts } from "../layout/size.js";
import { layerOf, nodeOf, type HierarchyIndex } from "../model/hierarchy.js";
import { drawnEdge, type GraphView, type ViewEdge, type ViewNode } from "../model/view.js";
import { prefersReducedMotion } from "../motion.js";
import { DiagramNode } from "../nodes/DiagramNode.js";
import { nodeTier, type NodeEmphasis } from "../nodes/describe.js";
import { durations, scaleTokens } from "../tokens.js";
import { detailAt, insideOneService, serviceNameScale } from "./detail.js";
import { planTransition, type BoxExit, type Shown, type TransitionPlan } from "./transition.js";

/** How a box looks besides its node: selected, and its part in a trace. */
export interface BoxLook {
  selected?: boolean | undefined;
  emphasis?: NodeEmphasis | undefined;
}

/**
 * How a line and its pill look: selected, its part in a trace, particles
 * flowing along it, and the current hop's pulse (which way the request goes
 * along the drawn line).
 */
export interface LineLook extends BoxLook {
  flow?: boolean | undefined;
  pulse?: "forward" | "backward" | undefined;
}

/** Props for {@link DrillCanvas}. */
export interface DrillCanvasProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onSelect"> {
  index: HierarchyIndex;
  /** The view to draw (from `useDrill` or `buildView`). */
  view: GraphView;
  /** Layouts of `index`'s views, one cache for the graph's life. */
  cache: Pick<LayoutCache, "layout" | "peek">;
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
}

/** Boxes leaving the canvas, kept for their fold. `generation` tells one transition's from the next's. */
interface Leaving {
  generation: number;
  boxes: readonly BoxExit[];
}

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
 * `zoom` thins the text out for a zoomed-out camera (`detail.ts`): the level
 * is drawn as `data-detail` and the service names' scale as
 * `--gi-name-scale`, with `data-inner` on each line between two boxes of one
 * service; `drill.css` fades and scales, so zooming never resizes a box.
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
  className,
  style,
  ...rest
}: DrillCanvasProps) {
  const [shown, setShown] = useState<Shown | undefined>(() => {
    const layout = cache.peek(view);
    return layout ? { view, layout } : undefined;
  });
  const [leaving, setLeaving] = useState<Leaving>({ generation: 0, boxes: [] });
  const [error, setError] = useState<string>();

  const stageRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<SVGSVGElement>(null);
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
    for (const el of [linesRef.current, labelsRef.current]) {
      for (const a of el?.getAnimations?.() ?? []) a.cancel();
    }
    return now;
  }

  useEffect(() => {
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
      setLeaving((l) => ({ generation: l.generation + 1, boxes: plan?.exits ?? [] }));
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
      const { generation, boxes } = leavingRef.current;
      for (const e of boxes) {
        const el = leavingEls.current.get(e.node.id);
        if (el) glide(el, e.from, e.from, e.to, [1, 0], "forwards");
      }
      fadeInAfter(linesRef.current);
      fadeInAfter(labelsRef.current);
      if (boxes.length > 0) {
        timer = setTimeout(
          () => setLeaving((l) => (l.generation === generation ? { generation, boxes: [] } : l)),
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

  /** Enter breaks a box down, or selects one that can't open further (UX.md); Space selects. */
  function onKeyDown(event: KeyboardEvent<HTMLElement>, n: ViewNode) {
    const opens = event.key === "Enter" && n.canOpen && !n.open && onOpen !== undefined;
    const selects = (event.key === "Enter" || event.key === " ") && !opens && onSelect;
    if (!opens && !selects) return;
    event.preventDefault();
    event.stopPropagation();
    if (opens) open(n);
    else onSelect?.(n.id);
  }

  const box = (n: ViewNode, rect: Rect, leavingBox: boolean) => {
    const frame = nodeTier(n.node) === "frame";
    const look = leavingBox ? {} : (boxLook?.(n) ?? {});
    const register = (el: HTMLElement | null) => {
      const map = leavingBox ? leavingEls.current : boxEls.current;
      if (el) map.set(n.id, el);
      else map.delete(n.id);
    };
    return (
      <div
        key={leavingBox ? `leaving:${n.id}` : n.id}
        ref={register}
        className="gi-drill__node"
        data-node-id={n.id}
        data-open={n.open ? "" : undefined}
        data-leaving={leavingBox ? "" : undefined}
        aria-hidden={leavingBox || undefined}
        inert={leavingBox || undefined}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        <DiagramNode
          node={n.node}
          layer={layerOf(index, n.id)}
          counts={frame && !n.open ? frameCounts(index, n.id) : []}
          expanded={n.open}
          selected={look.selected ?? false}
          emphasis={look.emphasis}
          tabIndex={leavingBox ? -1 : 0}
          data-can-open={n.canOpen && !n.open ? "" : undefined}
          onClick={
            leavingBox || !onSelect
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onSelect(n.id);
                }
          }
          onDoubleClick={
            leavingBox
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  open(n);
                }
          }
          onKeyDown={leavingBox ? undefined : (e) => onKeyDown(e, n)}
        />
      </div>
    );
  };

  const edges = new Map((drawn?.edges ?? []).map((e) => [e.id, e]));
  return (
    <div
      {...rest}
      className={className ? `gi-drill ${className}` : "gi-drill"}
      style={{ ...style, "--gi-name-scale": serviceNameScale(zoom) } as CSSProperties}
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
          {leaving.boxes.map((e) => box(e.node, e.from, true))}
          {/* One stable list in drawing order, so Tab reads a frame, then its inside. */}
          {shown.layout.boxes.map((b) => {
            const n = drawn.byId.get(b.id);
            return n ? box(n, b, false) : null;
          })}
          <svg
            ref={linesRef}
            className="gi-drill__lines"
            width={shown.layout.width}
            height={shown.layout.height}
            role="group"
            aria-label="Connections"
          >
            {shown.layout.edges.map((placed) => {
              const e = edges.get(placed.id);
              if (!e) return null;
              const { edge, count } = drawnEdge(e);
              const { selected, emphasis, flow, pulse } = lineLook?.(e) ?? {};
              return (
                <DiagramEdge
                  key={placed.id}
                  edge={edge}
                  count={count}
                  points={placed.points}
                  layer={layerOf(index, e.from)}
                  ends={{ from: nodeOf(index, e.from).label, to: nodeOf(index, e.to).label }}
                  selected={selected}
                  emphasis={emphasis}
                  flow={flow ?? false}
                  pulse={pulse}
                  data-inner={insideOneService(index, e) ? "" : undefined}
                />
              );
            })}
          </svg>
          <div ref={labelsRef} className="gi-drill__labels">
            {shown.layout.edges.map((placed) => {
              const e = edges.get(placed.id);
              if (!e) return null;
              const { edge, count } = drawnEdge(e);
              const { selected, emphasis } = lineLook?.(e) ?? {};
              return (
                <EdgeLabel
                  key={placed.id}
                  edge={edge}
                  count={count}
                  layer={layerOf(index, e.from)}
                  selected={selected}
                  emphasis={emphasis}
                  data-measured-width={edgeLabelSize(e).width}
                  style={{ left: placed.label.x, top: placed.label.y }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
