import type { AnalysisWarning } from "@gitinside/schema";
import { useId, useState, type ReactNode } from "react";
import { Kbd } from "../chrome/controls.js";
import { githubLineUrl, type RepoRef } from "../chrome/describe.js";
import { WarningList } from "../chrome/EmptyState.js";
import { InspectorSection } from "../chrome/Inspector.js";
import { UiIcon, type UiIconName } from "../chrome/uiIcons.js";
import { CONFIDENCE_TEXT, LINE_STYLE } from "../edges/describe.js";
import { IconTile, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import type { UnresolvedNode } from "../model/groups.js";
import { layerOf, type HierarchyIndex } from "../model/hierarchy.js";
import { nodeLabel } from "../nodes/describe.js";
import {
  allServices,
  confidenceMix,
  groupCountText,
  groupSites,
  serviceLine,
  type ConnectionGroup,
  type CountFact,
  type GridRow,
} from "./brief.js";

/**
 * The prototype's panel parts (M10.3c3, M10-design A8, B9, B10), drawn only under the
 * explorer's `design="prototype"`: the overview's fact row, "Try this", its services, the
 * Analysis notes at the foot, a node's fact grid, and Calls / Called by grouped by target.
 * The words come from `brief.ts`.
 */

/** How many items a fact grid's list shows before "+N". */
export const GRID_SHOWN = 3;

/** The overview's counts in one quiet row under its sentence: "2 services · 3 pages · …". */
export function FactRow({ facts }: { facts: readonly CountFact[] }) {
  if (facts.length === 0) return null;
  return (
    <ul className="gi-factrow" aria-label="Counts">
      {facts.map((f) => (
        <li key={f.noun}>
          <strong>{f.value.toLocaleString("en-US")}</strong> {f.value === 1 ? f.noun : `${f.noun}s`}
        </li>
      ))}
    </ul>
  );
}

/**
 * A node's facts as a grid (M10-design B9): a label, then its value or list. A name with a
 * node is a link that selects it (the explorer flies there); a list past {@link GRID_SHOWN}
 * ends in "+N", which shows the rest in place.
 */
export function FactGrid({
  rows,
  onSelect,
}: {
  rows: readonly GridRow[];
  onSelect?: ((id: string) => void) | undefined;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  return (
    <dl className="gi-factgrid">
      {rows.map((row) => {
        const all = opened.has(row.label);
        const shown = all ? row.items : row.items.slice(0, GRID_SHOWN);
        const rest = row.items.length - shown.length;
        return (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {shown.map((item, i) => {
                const text = item.code ? <code>{item.text}</code> : item.text;
                const { id } = item;
                return (
                  <span key={`${item.text} ${i}`} className="gi-factgrid__item">
                    {id !== undefined && onSelect ? (
                      <button
                        type="button"
                        className="gi-factgrid__link"
                        onClick={() => onSelect(id)}
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </span>
                );
              })}
              {rest > 0 && (
                <button
                  type="button"
                  className="gi-factgrid__more"
                  aria-label={`Show ${rest} more in ${row.label}`}
                  onClick={() => setOpened(new Set([...opened, row.label]))}
                >
                  +{rest}
                </button>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One "Try this" action. */
export interface TryAction {
  icon: UiIconName;
  label: ReactNode;
  /** A second line saying what it does. */
  detail?: string | undefined;
  shortcut?: readonly string[] | undefined;
  onClick: () => void;
}

/** "Try this" (M10-design A8): up to three one-click actions, each with what it does. */
export function TryThis({ actions }: { actions: readonly TryAction[] }) {
  if (actions.length === 0) return null;
  return (
    <InspectorSection title="Try this">
      <ul className="gi-try">
        {actions.map((a, i) => (
          <li key={i}>
            <button type="button" className="gi-try__action" onClick={a.onClick}>
              <UiIcon name={a.icon} size={16} />
              <span className="gi-try__text">
                <span className="gi-try__label">{a.label}</span>
                {a.detail && <span className="gi-try__detail">{a.detail}</span>}
              </span>
              {a.shortcut && <Kbd keys={a.shortcut} />}
            </button>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

/** The overview's services, each with its role and counts; a click flies to it. */
export function ServiceList({
  index,
  onSelect,
}: {
  index: HierarchyIndex;
  onSelect: (id: string) => void;
}) {
  const services = allServices(index);
  if (services.length === 0) return null;
  return (
    <InspectorSection title="Services" count={services.length}>
      <ul className="gi-connections">
        {services.map((s) => (
          <li key={s.id}>
            <button type="button" className="gi-connection" onClick={() => onSelect(s.id)}>
              <IconTile layer={s.layer ?? layerOf(index, s.id)}>
                <NodeIcon node={s} size={TILE_ICON_SIZE.sm} />
              </IconTile>
              <span className="gi-connection__text">
                <span className="gi-connection__name">
                  <span>{s.label}</span>
                </span>
                {/* Wraps rather than ending in "…": every count is a fact the reader came for. */}
                <span className="gi-connection__edge" data-wrap="">
                  {serviceLine(index, s)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

/** The overview's notes section, which Ctrl K's "Analysis notes" moves focus to. */
export const NOTES_SECTION = "warnings";

/**
 * The analysis's warnings as "Analysis notes", collapsed at the panel's foot (M10-design A8):
 * the same plain titles, under a one-line intro. Open or closed is the explorer's, so Ctrl K can
 * open it.
 */
export function AnalysisNotes({
  warnings,
  open,
  onToggle,
}: {
  warnings: readonly AnalysisWarning[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const id = useId();
  if (warnings.length === 0) return null;
  return (
    <section
      className="gi-inspector__section gi-notes"
      data-section={NOTES_SECTION}
      tabIndex={-1}
      aria-labelledby={id}
    >
      <h3>
        <button
          type="button"
          id={id}
          className="gi-notes__toggle"
          aria-expanded={open}
          onClick={() => onToggle(!open)}
        >
          <UiIcon name="chevron-right" size={14} />
          Analysis notes
          <span className="gi-count">{warnings.length.toLocaleString("en-US")}</span>
        </button>
      </h3>
      {open && (
        <>
          <p className="gi-inspector__empty">
            What the analysis skipped or couldn&apos;t read. Nothing here is guessed.
          </p>
          <WarningList warnings={warnings} />
        </>
      )}
    </section>
  );
}

/**
 * Every import in a "Not in the repo" group (M10-design B4), by file and line: what it asks for
 * (a link that selects it) and where, a link to the line on GitHub. Nothing is left out, so a
 * group of 84 lists 84; the box only groups them.
 */
export function ImportList({
  imports,
  repo,
  onSelect,
}: {
  imports: readonly UnresolvedNode[];
  repo: RepoRef;
  onSelect?: ((id: string) => void) | undefined;
}) {
  if (imports.length === 0) return null;
  return (
    <InspectorSection title="Imports" count={imports.length}>
      <ul className="gi-imports">
        {imports.map((n) => {
          const where = n.source && `${n.source.file}:${n.source.line}`;
          const href = n.source && githubLineUrl(repo, n.source.file, n.source.line);
          return (
            <li key={n.id}>
              <button type="button" className="gi-factgrid__link" onClick={() => onSelect?.(n.id)}>
                <code>{n.expression}</code>
              </button>
              {where &&
                (href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`Open ${where} on GitHub`}
                  >
                    <code>{where}</code>
                  </a>
                ) : (
                  <code>{where}</code>
                ))}
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}

/**
 * Calls or Called by grouped by target (M10-design B10): one row per node at the other end,
 * "2 calls · Heuristic match" with the weakest confidence (the mix in its tooltip), and its call
 * sites listed, each a link to the line on GitHub, when the row is opened.
 */
export function GroupedConnections({
  index,
  groups,
  empty,
  repo,
  onSelect,
}: {
  index: HierarchyIndex;
  groups: readonly ConnectionGroup[];
  empty: string;
  repo: RepoRef;
  onSelect?: ((id: string) => void) | undefined;
}) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const base = useId();
  if (groups.length === 0) return <p className="gi-inspector__empty">{empty}</p>;
  return (
    <ul className="gi-connections">
      {groups.map((group, i) => {
        const { other, weakest } = group;
        const label = nodeLabel(other);
        const sites = groupSites(group);
        const open = opened.has(other.id);
        const listId = `${base}-${i}`;
        return (
          <li key={other.id}>
            <div className="gi-connection-group">
              <button
                type="button"
                className="gi-connection"
                onClick={() => onSelect?.(other.id)}
                title={`${other.label} · ${confidenceMix(group)}`}
              >
                <IconTile layer={other.layer ?? layerOf(index, other.id)}>
                  <NodeIcon node={other} size={TILE_ICON_SIZE.sm} />
                </IconTile>
                <span className="gi-connection__text">
                  <span className="gi-connection__name">
                    {label.method && <span className="gi-method">{label.method}</span>}
                    {label.text && <span>{label.text}</span>}
                    {label.code && <code>{label.code}</code>}
                  </span>
                  <span className="gi-connection__edge">
                    {groupCountText(group)} · {CONFIDENCE_TEXT[weakest]}
                  </span>
                </span>
                <svg
                  className="gi-connection__line"
                  data-line={LINE_STYLE[weakest]}
                  width={20}
                  height={8}
                  aria-hidden
                >
                  <path d="M 1 4 L 19 4" />
                  {LINE_STYLE[weakest] === "dot" && <circle cx={4} cy={4} r={2} />}
                </svg>
              </button>
              {sites.length > 0 && (
                <button
                  type="button"
                  className="gi-connection__sites-toggle"
                  aria-expanded={open}
                  aria-controls={open ? listId : undefined}
                  aria-label={`${open ? "Hide" : "Show"} ${sites.length === 1 ? "the call site" : `${sites.length} call sites`} for ${other.label}`}
                  onClick={() => {
                    const next = new Set(opened);
                    if (open) next.delete(other.id);
                    else next.add(other.id);
                    setOpened(next);
                  }}
                >
                  <UiIcon name="chevron-right" size={14} />
                </button>
              )}
            </div>
            {open && (
              <ul id={listId} className="gi-connection__sites">
                {sites.map((s, j) => {
                  const href = githubLineUrl(repo, s.file, s.line);
                  const text = `${s.file}:${s.line}`;
                  return (
                    <li key={`${text} ${j}`}>
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={`Open ${text} on GitHub`}
                        >
                          <code>{text}</code>
                        </a>
                      ) : (
                        <code>{text}</code>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
