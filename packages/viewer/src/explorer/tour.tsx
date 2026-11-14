import { compareStrings, type GraphNode } from "@gitinside/schema";
import { useId, type ReactNode } from "react";
import { Button, IconButton } from "../chrome/controls.js";
import type { HierarchyIndex } from "../model/hierarchy.js";
import { systemSentence } from "./brief.js";
import { impactCountText, impactOf } from "./impact.js";
import type { Suggestion } from "./suggest.js";
import { traceName } from "./trace.js";
import type { TourBreak } from "./tourBreak.js";

/**
 * The prototype's guided tour (M10.3f2a, M10-design §3.1): a few steps, each doing its action on
 * the real diagram, read from a card docked at the top of the inspector. The steps and their
 * words come from the graph, so every count is the repo's own. A step whose action the repo
 * can't show (no hub, nothing to trace, no route another service calls, no model) is left out
 * rather than faked. The broken connection (M10.3f2b) is the one step on made-up data: a canned
 * PR (`tourBreak`), which its words call an example.
 */

/** A tour step's action on the diagram. */
export type TourAction =
  | { kind: "system" }
  | { kind: "breakdown"; hub: string }
  | { kind: "trace"; start: string }
  /** The diff overlay of the canned PR removing `route` (`TourContext.broken`). */
  | { kind: "broken"; route: string }
  | { kind: "impact"; target: string };

/** One step of the tour: what it does, and what the card says. */
export interface TourStep {
  action: TourAction;
  title: string;
  /** One or two sentences, also read by the live region. */
  text: string;
}

/** How many hops the trace step plays (M10-design §3.1: "its first three hops"). */
export const TOUR_HOPS = 3;

/**
 * What the steps need from the explorer: the system level's hub, the first suggested trace, and
 * the canned PR's break.
 */
export interface TourContext {
  hub?: GraphNode | undefined;
  suggestion?: Suggestion | undefined;
  broken?: TourBreak | undefined;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * The model the impact step asks about: the one the most depends on (ties by ID), so the step
 * shows a change felt widely; none when no model has a dependent.
 */
export function tourImpactTarget(index: HierarchyIndex): GraphNode | undefined {
  let best: { node: GraphNode; count: number } | undefined;
  const models = index.graph.nodes
    .filter((n) => n.kind === "model")
    .sort((a, b) => compareStrings(a.id, b.id));
  for (const node of models) {
    const count = impactOf(index, node.id).dependents.size;
    if (count > 0 && (best === undefined || count > best.count)) best = { node, count };
  }
  return best?.node;
}

/** What breaking the hub down shows, in words: its routes and pages, else what's inside it. */
function breakdownText(index: HierarchyIndex, hub: GraphNode): string {
  const count = (kind: GraphNode["kind"]) =>
    index.graph.nodes.filter((n) => n.kind === kind && index.service.get(n.id) === hub.id).length;
  const entries = [
    ...(count("route") > 0 ? [plural(count("route"), "route")] : []),
    ...(count("page") > 0 ? [plural(count("page"), "page")] : []),
  ];
  if (entries.length === 0) {
    return `${hub.label} opens to the folders and code inside it, each found by parsing the code.`;
  }
  return `${hub.label} opens to its ${entries.join(" and ")}, grouped by path, each found by parsing the code.`;
}

/** The tour's steps for a graph, in order; see the module comment for what's left out. */
export function tourSteps(index: HierarchyIndex, context: TourContext): TourStep[] {
  const steps: TourStep[] = [
    {
      action: { kind: "system" },
      title: "The system",
      text: `Each column is one layer, from what users see on the left to outside APIs on the right. ${systemSentence(index)}`,
    },
  ];
  const { hub, suggestion } = context;
  if (hub) {
    steps.push({
      action: { kind: "breakdown", hub: hub.id },
      title: "Break it down",
      text: breakdownText(index, hub),
    });
  }
  if (suggestion) {
    steps.push({
      action: { kind: "trace", start: suggestion.node.id },
      title: "Trace a request",
      text: `This is the path ${traceName(suggestion.node)} takes: ${suggestion.shape}. Press T anytime to trace one yourself.`,
    });
  }
  const { broken } = context;
  if (broken) {
    steps.push({
      action: { kind: "broken", route: broken.route.id },
      title: "A broken connection",
      text: `An example PR removes ${broken.route.label}, which ${traceName(broken.caller)} still calls. The diff draws that line broken: this is what the PR bot flags.`,
    });
  }
  const target = tourImpactTarget(index);
  if (target) {
    const impact = impactOf(index, target.id);
    steps.push({
      action: { kind: "impact", target: target.id },
      title: "What depends on this",
      text: `Everything that would feel a change to ${target.label}: ${impactCountText(impact).toLowerCase()}. Press I on any box to ask the same.`,
    });
  }
  return steps;
}

/** The card's words after the last step. */
export const TOUR_DONE = {
  title: "Your turn",
  text: "That's GitInside: drawn from the code, nothing guessed. Try it on your own repo, or keep exploring this one.",
} as const;

/** Props for {@link TourCard}. */
export interface TourCardProps {
  steps: readonly TourStep[];
  /** The step shown (0-based); `steps.length` is the Done card (← goes back from it). */
  at: number;
  onBack: () => void;
  onNext: () => void;
  /** Skip ✕, and "Explore on your own" on the Done card. */
  onEnd: () => void;
  /** A repo field for the Done card (the website's), which "Paste your own repo" focuses. */
  field?: ReactNode;
}

/**
 * The tour's card (M10-design §3.1), docked at the top of the inspector so it never covers a
 * box: `Tour · k of n` and Skip ✕, the step's title (its heading, which the explorer focuses at
 * each step) and words, then dots and Back / Next →. The Done card offers the host's repo field
 * and "Explore on your own". → and ← step and Esc skips while focus is in the card (the
 * explorer's keys).
 */
export function TourCard({ steps, at, onBack, onNext, onEnd, field }: TourCardProps) {
  const headingId = useId();
  const done = at >= steps.length;
  const step = done ? TOUR_DONE : steps[at];
  if (!step) return null;
  const total = steps.length;
  return (
    <section className="gi-tour" aria-labelledby={headingId} data-done={done ? "" : undefined}>
      <div className="gi-tour__top">
        <span className="gi-tour__count">
          {done ? "Tour · done" : `Tour · ${at + 1} of ${total}`}
        </span>
        <IconButton icon="close" label="Skip tour" size="sm" onClick={onEnd} />
      </div>
      {/* Keyed by the step, so its words fade in anew (chrome.css). */}
      <h2 key={`title-${at}`} id={headingId} className="gi-tour__title" tabIndex={-1}>
        {step.title}
      </h2>
      <p key={`text-${at}`} className="gi-tour__text">
        {step.text}
      </p>
      {done ? (
        <>
          {/* The buttons first: "Paste your own repo" goes to the field just under them. */}
          <div className="gi-tour__foot">
            {field && (
              <Button
                variant="primary"
                size="sm"
                onClick={(e) =>
                  e.currentTarget
                    .closest(".gi-tour")
                    ?.querySelector<HTMLElement>(".gi-tour__field input")
                    ?.focus()
                }
              >
                Paste your own repo
              </Button>
            )}
            <Button variant={field ? "secondary" : "primary"} size="sm" onClick={onEnd}>
              Explore on your own
            </Button>
          </div>
          {field && <div className="gi-tour__field">{field}</div>}
        </>
      ) : (
        <div className="gi-tour__foot">
          <span className="gi-tour__dots" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.title} className="gi-tour__dot" data-on={i <= at ? "" : undefined} />
            ))}
          </span>
          <Button variant="quiet" size="sm" onClick={onBack} disabled={at === 0}>
            Back
          </Button>
          <Button variant="primary" size="sm" onClick={onNext} shortcut={["→"]}>
            {at + 1 < total ? "Next" : "Finish"}
          </Button>
        </div>
      )}
    </section>
  );
}
