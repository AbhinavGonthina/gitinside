import { useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { AnalysisWarning } from "@gitinside/schema";
import { groupWarnings } from "../model/warnings.js";
import { Button } from "./controls.js";
import { LogoMark } from "./uiIcons.js";

/** Props for {@link EmptyState}. */
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** What happened, as a heading: "No TypeScript or JavaScript app here". */
  title: ReactNode;
  /** `error`: something failed (a red rule beside the words); `neutral`: there's just nothing to show. */
  tone?: "neutral" | "error";
  /** Buttons or links under the words. */
  actions?: ReactNode;
  ref?: Ref<HTMLDivElement> | undefined;
}

/**
 * A state in place of the diagram (UX.md "States", M4b.12b): one quiet card,
 * centered where the canvas would be, with the mark, a heading that says what
 * happened, the words that say why and what to do, and the actions. Used for
 * a repo with no app to draw and for a graph that failed to load.
 */
export function EmptyState({
  title,
  tone = "neutral",
  actions,
  children,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div {...rest} className={className ? `gi-empty ${className}` : "gi-empty"} data-tone={tone}>
      <LogoMark size={28} />
      <h2 className="gi-empty__title">{title}</h2>
      {children !== undefined && <div className="gi-empty__body">{children}</div>}
      {actions !== undefined && <div className="gi-empty__actions">{actions}</div>}
    </div>
  );
}

/** Props for {@link WarningList}. */
export interface WarningListProps {
  warnings: readonly AnalysisWarning[];
  /** How many of a group's warnings show before its "Show all" (default 5). */
  limit?: number;
}

/**
 * The analysis's warnings (ADR-0070), grouped under plain-English titles
 * (`groupWarnings`), each with its file and the analyzer's own message. A
 * group longer than `limit` shows its first warnings and a "Show all" /
 * "Show fewer" toggle.
 */
export function WarningList({ warnings, limit = 5 }: WarningListProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="gi-warnings">
      {groupWarnings(warnings).map((g) => {
        const long = g.warnings.length > limit;
        const open = expanded.has(g.code);
        const shown = open || !long ? g.warnings : g.warnings.slice(0, limit);
        const toggle = () => {
          const next = new Set(expanded);
          if (open) next.delete(g.code);
          else next.add(g.code);
          setExpanded(next);
        };
        return (
          <div key={g.code} className="gi-warnings__group" data-code={g.code}>
            <h4 className="gi-warnings__title">
              {g.title}
              <span className="gi-count">{g.warnings.length.toLocaleString("en-US")}</span>
            </h4>
            <ul className="gi-warnings__items">
              {shown.map((w, i) => (
                <li key={i}>
                  {w.file !== undefined && <code title={w.file}>{w.file}</code>}
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
            {/* Stays put as it toggles, so focus on it does too. */}
            {long && (
              <Button variant="quiet" size="sm" aria-expanded={open} onClick={toggle}>
                {open ? "Show fewer" : `Show all ${g.warnings.length.toLocaleString("en-US")}`}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
