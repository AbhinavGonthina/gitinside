import type { GraphDiff } from "@gitinside/schema";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { IconButton } from "../chrome/controls.js";
import type { Presence } from "../motion.js";
import type { History, HistoryCounts } from "./timeline.js";

/**
 * The prototype's timeline drawer (M10.3f4, M10-design §3.4) along the canvas's foot: a sparkline
 * per count across the commits, a slider over them, and what the commit under the handle (or the
 * pointer) changed. The explorer draws the commit the handle lands on as a diff against the one
 * before it; while the handle is dragged only the words follow it, and the diff comes on release.
 * ← → (and Home, End) move it a commit at a time, the native range's own keys; Esc and ✕ close
 * the drawer. The history is canned (`cannedHistory`), and the drawer's title says so.
 */

/** The sparklines, in the order drawn. */
const SPARKS: readonly { key: keyof HistoryCounts; label: string }[] = [
  { key: "entries", label: "pages & routes" },
  { key: "connections", label: "connections" },
  { key: "broken", label: "broken" },
];

/** The tallest sparkline bar, in px; the shortest is a quarter of it. */
const SPARK_HEIGHT = 16;

/** Props for {@link HistoryDrawer}. */
export interface HistoryDrawerProps {
  history: History;
  /** The commit drawn on the canvas (0 is the oldest). */
  at: number;
  /** What the drawn commit changed, in words ("2 added · 1 broken"). */
  changes: string;
  /** The handle landed on a commit: a key, a click, or the end of a drag. */
  onMove: (at: number) => void;
  onClose: () => void;
  state: Exclude<Presence, null>;
}

/** How a commit reads in the slider and the caption: `example 7, 7 of 12: Add 3 routes in chat.js`. */
export function commitText(history: History, at: number): string {
  const commit = history.commits[at];
  if (!commit) return "";
  return `${commit.name}, ${at + 1} of ${history.commits.length}: ${commit.message}`;
}

/**
 * What a commit's diff changed, in words: `2 added · 1 removed · 1 broken`. A request left
 * unmatched by a removed route counts as broken, not as an added node.
 */
export function changesText(diff: GraphDiff): string {
  const added = diff.nodes.added.filter((n) => n.kind !== "unresolved").length;
  const removed = diff.nodes.removed.filter((id) => !id.startsWith("unresolved:")).length;
  const changed = diff.nodes.modified.length + diff.nodes.renamed.length;
  const parts = [
    ...(added > 0 ? [`${added.toLocaleString("en-US")} added`] : []),
    ...(removed > 0 ? [`${removed.toLocaleString("en-US")} removed`] : []),
    ...(changed > 0 ? [`${changed.toLocaleString("en-US")} changed`] : []),
    ...(diff.broken.length > 0 ? [`${diff.broken.length.toLocaleString("en-US")} broken`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "no changes";
}

/** One count across the commits, the one at `at` marked, with its value. */
function Spark({ label, values, at }: { label: string; values: number[]; at: number }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = 6;
  const height = (v: number) =>
    max === min
      ? SPARK_HEIGHT / 2
      : SPARK_HEIGHT / 4 + Math.round(((v - min) / (max - min)) * (SPARK_HEIGHT * 0.75));
  return (
    <div className="gi-history__spark">
      <span className="gi-history__spark-label">{label}</span>
      <svg
        className="gi-history__bars"
        width={values.length * step - 2}
        height={SPARK_HEIGHT}
        aria-hidden="true"
      >
        {values.map((v, i) => (
          <rect
            key={i}
            x={i * step}
            y={SPARK_HEIGHT - height(v)}
            width={step - 2}
            height={height(v)}
            rx={1}
            className="gi-history__bar"
            data-on={i === at ? "" : undefined}
          />
        ))}
      </svg>
      <span className="gi-history__spark-value">{(values[at] ?? 0).toLocaleString("en-US")}</span>
    </div>
  );
}

/** The timeline drawer; see the module comment. */
export function HistoryDrawer({
  history,
  at,
  changes,
  onMove,
  onClose,
  state,
}: HistoryDrawerProps) {
  const headingId = useId();
  const { commits } = history;
  const last = commits.length - 1;
  // The handle while dragged (the canvas keeps `at` until release), and the tick under the pointer.
  const [pending, setPending] = useState(at);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setPending(at);
  }, [at]);
  const shown = hover ?? pending;
  const commit = commits[shown];
  const closing = state === "closing";

  /** The tick nearest the pointer, across the track's ends (the thumb's centre at each). */
  function tickAt(event: PointerEvent<HTMLElement>): number {
    const box = event.currentTarget.getBoundingClientRect();
    const inset = 8;
    const ratio = (event.clientX - box.left - inset) / Math.max(1, box.width - 2 * inset);
    return Math.max(0, Math.min(last, Math.round(ratio * last)));
  }

  function release(value: number) {
    if (!dragging.current) return;
    dragging.current = false;
    onMove(value);
  }

  return (
    <section
      className="gi-history"
      data-state={state}
      inert={closing || undefined}
      aria-hidden={closing || undefined}
      aria-labelledby={headingId}
    >
      <div className="gi-history__top">
        <h2 id={headingId} className="gi-history__title">
          History
          <span className="gi-history__note"> · an example: {commits.length} made-up commits</span>
        </h2>
        <div className="gi-history__sparks">
          {SPARKS.map(({ key, label }) => (
            <Spark key={key} label={label} values={commits.map((c) => c.counts[key])} at={shown} />
          ))}
        </div>
        <IconButton icon="close" label="Close history" size="sm" onClick={onClose} />
      </div>
      <div
        className="gi-history__track"
        onPointerMove={(e) => setHover(dragging.current ? null : tickAt(e))}
        onPointerLeave={() => setHover(null)}
      >
        <span className="gi-history__ticks" aria-hidden="true">
          {commits.map((c, i) => (
            <span
              key={i}
              className="gi-history__tick"
              data-on={i === pending ? "" : undefined}
              data-broken={
                c.counts.broken > (commits[i - 1]?.counts.broken ?? c.counts.broken)
                  ? ""
                  : undefined
              }
            />
          ))}
        </span>
        <input
          type="range"
          className="gi-history__range"
          min={0}
          max={last}
          step={1}
          value={pending}
          aria-label="Commit"
          aria-valuetext={commitText(history, pending)}
          onChange={(e) => {
            const value = Number(e.currentTarget.value);
            setPending(value);
            if (!dragging.current) onMove(value);
          }}
          onPointerDown={() => {
            dragging.current = true;
            setHover(null);
          }}
          onPointerUp={(e) => release(Number(e.currentTarget.value))}
          onPointerCancel={(e) => release(Number(e.currentTarget.value))}
        />
      </div>
      <p className="gi-history__caption">
        {commit && (
          <span className="gi-history__commit" data-preview={shown !== at ? "" : undefined}>
            <code>{commit.name}</code> · {commit.message}
            {shown === at && changes !== "" && <> · {changes}</>}
          </span>
        )}
      </p>
    </section>
  );
}
