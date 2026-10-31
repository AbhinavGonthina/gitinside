import { useId, type ReactNode } from "react";
import { Button, IconButton, Kbd } from "../chrome/controls.js";
import type { Presence } from "../motion.js";

/**
 * First-visit hints (UX.md "Onboarding", M4b.12a): three tips in turn, zoom
 * in → select → trace, each moved on by doing what it says or by Next. The
 * last one done, or "Don't show again", is remembered per browser; the close
 * button hides them for this visit only.
 */

/** A hint, named by what it teaches. */
export type HintStep = "zoom" | "select" | "trace";

/** Where the explorer keeps whether this browser is done with the hints. */
export interface OnboardingStore {
  /** Whether the hints were finished or turned off here before. */
  done(): boolean;
  /** Don't show them again. */
  remember(): void;
}

/** The `localStorage` key {@link browserOnboarding} writes. */
export const ONBOARDING_KEY = "gitinside.onboarding";

/**
 * The hints' store in this browser's `localStorage`. Storage that can't be
 * read (blocked cookies, a sandboxed frame) shows the hints, and one that
 * can't be written forgets they were done: neither stops the explorer.
 * `storage` is read on each call, since even reading `window.localStorage`
 * can throw.
 */
export function browserOnboarding(
  storage: () => Storage | undefined = () =>
    typeof window === "undefined" ? undefined : window.localStorage,
): OnboardingStore {
  return {
    done() {
      try {
        return storage()?.getItem(ONBOARDING_KEY) === "done";
      } catch {
        return false;
      }
    },
    remember() {
      try {
        storage()?.setItem(ONBOARDING_KEY, "done");
      } catch {
        // Nowhere to keep it: the hints come back next visit.
      }
    },
  };
}

/** A store kept in memory only (stories, tests, a host with its own settings), starting at `done`. */
export function memoryOnboarding(done = false): OnboardingStore {
  let finished = done;
  return {
    done: () => finished,
    remember() {
      finished = true;
    },
  };
}

/** What the explorer opened with, which decides the hints worth showing. */
export interface HintContext {
  /** Some box on the first canvas can break down. */
  canBreakDown: boolean;
  /** It opened with something broken down (a deep link). */
  opened: boolean;
  /** It opened with a selection. */
  selected: boolean;
  /** T has something to trace or to pick from. */
  canTrace: boolean;
  /** It opened tracing. */
  tracing: boolean;
}

/**
 * The hints to show, in UX.md's order, leaving out one the reader has
 * already done (a deep link opened that way) or can't do in this repo
 * (nothing to break down, no request path), so no tip asks for the
 * impossible.
 */
export function hintSteps(context: HintContext): HintStep[] {
  const steps: HintStep[] = [];
  if (context.canBreakDown && !context.opened) steps.push("zoom");
  if (!context.selected) steps.push("select");
  if (context.canTrace && !context.tracing) steps.push("trace");
  return steps;
}

/** Each hint's title and words. Kept short: the canvas is the hero. */
const HINTS: Readonly<Record<HintStep, { title: string; body: ReactNode }>> = {
  zoom: {
    title: "Zoom in",
    body: (
      <>
        Double-click a service, or press <Keys keys={["Enter"]} /> on it, to break it down into its
        routes and folders. <Keys keys={["Esc"]} /> goes back up.
      </>
    ),
  },
  select: {
    title: "Select a box",
    body: <>Click a box to see what it does, what it calls, what calls it, and its code.</>,
  },
  trace: {
    title: "Trace a request",
    body: (
      <>
        Press <Keys keys={["T"]} /> to follow a request from a page or route through the code, hop
        by hop.
      </>
    ),
  },
};

/** Key caps, with the key's name for screen readers (`Kbd` is drawn only). */
function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <>
      <Kbd keys={keys} />
      <span className="gi-visually-hidden">{keys.join(" ")}</span>
    </>
  );
}

/** Props for {@link OnboardingHint}. */
export interface OnboardingHintProps {
  step: HintStep;
  /** The hint's place (0-based) among `total`. */
  position: number;
  total: number;
  /** From `usePresence`: a closing hint plays its exit and is inert. */
  state: Exclude<Presence, null>;
  /** Next, or Done on the last hint. */
  onNext: () => void;
  /** The close button: hide the hints for this visit. */
  onClose: () => void;
  /** "Don't show again". */
  onNever: () => void;
}

/**
 * One hint, a small card on the canvas: "Tip 1 of 3", its title and words,
 * "Don't show again", and Next (Done on the last). The words swap in place
 * between hints, so the buttons, and focus on them, stay put.
 */
export function OnboardingHint({
  step,
  position,
  total,
  state,
  onNext,
  onClose,
  onNever,
}: OnboardingHintProps) {
  const titleId = useId();
  const hint = HINTS[step];
  const last = position === total - 1;
  return (
    <section
      className="gi-hint"
      aria-labelledby={titleId}
      data-state={state}
      data-step={step}
      inert={state === "closing" || undefined}
      aria-hidden={state === "closing" || undefined}
    >
      <header className="gi-hint__header">
        <span className="gi-hint__count">
          Tip {position + 1} of {total}
        </span>
        <IconButton icon="close" label="Close tips" size="sm" onClick={onClose} />
      </header>
      <div key={step} className="gi-hint__body">
        <h2 id={titleId}>{hint.title}</h2>
        <p>{hint.body}</p>
      </div>
      <footer className="gi-hint__actions">
        <Button variant="quiet" size="sm" onClick={onNever}>
          Don&apos;t show again
        </Button>
        <Button variant="secondary" size="sm" onClick={onNext}>
          {last ? "Done" : "Next"}
        </Button>
      </footer>
    </section>
  );
}
