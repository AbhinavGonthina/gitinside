import { useEffect, useRef, type RefObject } from "react";
import { panBy, wheelZoomFactor, zoomAt, type Camera, type Point, type Size } from "./camera.js";

/**
 * How a camera change moves (explorer.css): with the drill-down's glide
 * (`layout`), like a panel (`standard`, the zoom buttons and keys), or at once
 * (`none`: the pointer, the wheel, the minimap, which already move smoothly).
 */
export type CameraMotion = "layout" | "standard" | "none";

/** What a gesture reads when it starts: the camera as drawn, the diagram's size, the canvas's. */
export interface CameraState {
  camera: Camera;
  size: Size;
  canvas: Size;
}

/** How far a pointer moves before a press becomes a pan, in canvas px (less is a click). */
export const DRAG_THRESHOLD = 4;

/** Pixels per wheel "line" (`deltaMode` 1), as browsers scroll a page by them. */
const LINE = 16;

/**
 * Pan and zoom by pointer on the explorer's canvas (UX.md "Layout", M4b.4):
 *
 * - **Wheel or trackpad scroll** pans; with Ctrl or ⌘ (and a trackpad pinch,
 *   which browsers send as Ctrl + wheel) it zooms around the pointer. Shift
 *   turns a mouse wheel's vertical scroll into a horizontal pan.
 * - **Dragging** with the main button, a finger, or a pen pans, from anywhere
 *   on the canvas, a box included; a press that moves less than
 *   {@link DRAG_THRESHOLD} is still a click, and the click that ends a drag is
 *   swallowed so it doesn't select or clear.
 * - **Two fingers** pinch-zoom around their midpoint and pan with it.
 *
 * The canvas's corner overlays (zoom, legend, minimap, breadcrumbs) keep
 * their own pointer and wheel. Listeners are native, since React's wheel
 * listener is passive and can't stop the page from scrolling.
 */
export function useCanvasGestures(
  ref: RefObject<HTMLElement | null>,
  live: RefObject<CameraState>,
  move: (camera: Camera, motion: CameraMotion) => void,
): void {
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onOverlay = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".gi-explorer__pin") !== null;
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function onWheel(e: WheelEvent) {
      if (onOverlay(e.target)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? live.current.canvas.height : 1;
      const { camera } = live.current;
      if (e.ctrlKey || e.metaKey) {
        const zoom = camera.zoom * wheelZoomFactor(e.deltaY * unit);
        moveRef.current(zoomAt(camera, zoom, local(e)), "none");
        return;
      }
      const sideways = e.shiftKey && e.deltaX === 0;
      const dx = (sideways ? e.deltaY : e.deltaX) * unit;
      const dy = (sideways ? 0 : e.deltaY) * unit;
      moveRef.current(panBy(camera, -dx, -dy), "none");
    }

    /** Pointers pressed on the canvas, where they are now. */
    const pointers = new Map<number, Point>();
    /** The gesture in progress: the camera and the pointers when it (re)started. */
    let gesture: { camera: Camera; from: Map<number, Point>; moved: boolean } | undefined;
    let swallowClick = false;

    /** Once a press is a pan: every pointer in it reports to the canvas, wherever it goes. */
    const capture = () => {
      el.dataset.panning = "";
      for (const id of pointers.keys()) {
        try {
          el.setPointerCapture(id);
        } catch {
          // A pointer already up can't be captured; it's leaving the map anyway.
        }
      }
    };

    /** (Re)starts the gesture from the pointers down now: a finger added or lifted starts afresh. */
    const restart = (moved: boolean) => {
      gesture =
        pointers.size > 0
          ? { camera: live.current.camera, from: new Map(pointers), moved }
          : undefined;
      if (!gesture) delete el.dataset.panning;
      else if (moved) capture();
    };

    function onPointerDown(e: PointerEvent) {
      if (pointers.size === 0) swallowClick = false;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (onOverlay(e.target)) return;
      pointers.set(e.pointerId, local(e));
      restart(gesture?.moved ?? false);
    }

    function onPointerMove(e: PointerEvent) {
      if (!gesture || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      const [first, second] = [...gesture.from.keys()];
      const a0 = first === undefined ? undefined : gesture.from.get(first);
      const a = first === undefined ? undefined : pointers.get(first);
      if (!a0 || !a) return;
      const b0 = second === undefined ? undefined : gesture.from.get(second);
      const b = second === undefined ? undefined : pointers.get(second);
      let next: Camera;
      if (b0 && b) {
        const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const ratio =
          Math.hypot(a.x - b.x, a.y - b.y) / Math.max(Math.hypot(a0.x - b0.x, a0.y - b0.y), 1);
        const zoomed = zoomAt(gesture.camera, gesture.camera.zoom * ratio, mid0);
        next = panBy(zoomed, mid.x - mid0.x, mid.y - mid0.y);
      } else {
        const dx = a.x - a0.x;
        const dy = a.y - a0.y;
        if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        next = panBy(gesture.camera, dx, dy);
      }
      if (!gesture.moved) {
        gesture.moved = true;
        capture();
      }
      moveRef.current(next, "none");
    }

    function onPointerUp(e: PointerEvent) {
      if (!pointers.delete(e.pointerId)) return;
      if (gesture?.moved) swallowClick = true;
      restart(gesture?.moved ?? false);
    }

    function onClickCapture(e: MouseEvent) {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("click", onClickCapture, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("click", onClickCapture, { capture: true });
    };
  }, [ref, live]);
}
