import type { GraphNode, Layer } from "@gitinside/schema";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { IconTile, NodeIcon, TILE_ICON_SIZE } from "../icons/Icon.js";
import { kindName, nodeLabel } from "../nodes/describe.js";
import { Kbd } from "./controls.js";
import { highlightSegments } from "./describe.js";
import { UiIcon } from "./uiIcons.js";

/** One search result: a node, where it lives, and which characters matched. */
export interface PaletteResult {
  node: GraphNode;
  /** The layer it inherits from its service, for kinds without their own. */
  layer?: Layer | undefined;
  /** Where it lives, shown muted on the right (a file path, a service root). */
  path?: string | undefined;
  /** `[start, end)` offsets into `node.label` that matched the query. */
  matches?: readonly (readonly [number, number])[] | undefined;
}

/** Props for {@link CommandPalette}. */
export interface CommandPaletteProps {
  query: string;
  results: readonly PaletteResult[];
  /** The highlighted result, which Enter opens. */
  activeIndex?: number;
  onQueryChange?: ((query: string) => void) | undefined;
  onActiveIndexChange?: ((index: number) => void) | undefined;
  /** Open that node: the explorer flies there, drilling as needed, and selects it. */
  onPick?: ((id: string) => void) | undefined;
  onClose?: (() => void) | undefined;
  /**
   * `"closing"` while it plays its exit (from `usePresence`): it fades out,
   * ignores the pointer, and leaves the accessibility tree. Default `"open"`.
   */
  state?: "open" | "closing" | undefined;
  /** The dialog's accessible name. Default "Search the diagram". */
  label?: string | undefined;
  /** The field's placeholder and accessible name. Default "Search services, files, routes". */
  placeholder?: string | undefined;
  /** What to say when nothing matches, instead of the search hints. */
  empty?: ReactNode;
  /** What Enter does, in the footer ("to open" by default). */
  pickVerb?: string | undefined;
  /** Move focus into the field when it opens. */
  autoFocus?: boolean | undefined;
  /** Nodes the filters hide: their results say so (picking one shows it). */
  hidden?: ReadonlySet<string> | undefined;
}

/** Names drawn in the mono face (code-like), like on the canvas. */
function isCode(node: GraphNode): boolean {
  const label = nodeLabel(node);
  return label.code !== undefined;
}

/**
 * The Ctrl+K command palette shell (UX.md "Search: command palette"): a
 * dialog over a scrim with a search field and a list of results, each with
 * its icon, name (matched characters marked), kind, and path. It is a
 * combobox: focus stays in the field, arrow keys move the active result,
 * Enter opens it, Esc closes; Tab and presses inside the dialog leave focus
 * in the field. It draws whatever results it is given (the explorer's
 * search is `searchNodes`, its trace picker `filterChoices`).
 */
export function CommandPalette({
  query,
  results,
  activeIndex = 0,
  onQueryChange,
  onActiveIndexChange,
  onPick,
  onClose,
  state = "open",
  label = "Search the diagram",
  placeholder = "Search services, files, routes",
  empty,
  pickVerb = "open",
  autoFocus = false,
  hidden,
}: CommandPaletteProps) {
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (i: number) => `${id}-option-${i}`;
  const active = results.length ? Math.min(Math.max(activeIndex, 0), results.length - 1) : -1;
  // Focus the field on every open, also when reopened mid-exit (the same
  // element, so an `autoFocus` attribute wouldn't fire again).
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus && state === "open") fieldRef.current?.focus();
  }, [autoFocus, state]);
  // Arrow keys can move the active result past the list's edge: keep it in view.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const option = listRef.current?.children[active];
    if (option instanceof HTMLElement) option.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const n = results.length;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
    } else if (event.key === "Tab") {
      // The field is the dialog's only stop: Tab mustn't leave a modal dialog.
      event.preventDefault();
    } else if (n && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      onActiveIndexChange?.((active + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      onPick?.((results[active] as PaletteResult).node.id);
    }
  };

  return (
    <div
      className="gi-palette-scrim"
      data-state={state}
      inert={state === "closing" || undefined}
      aria-hidden={state === "closing" || undefined}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="gi-palette"
        onClick={(e) => e.stopPropagation()}
        // Focus stays in the field: a press on a result, the hints, or the
        // dialog's edge would otherwise move it to the page, where arrows,
        // Enter, and Esc do nothing.
        onMouseDown={(e) => {
          if (e.target !== fieldRef.current) e.preventDefault();
        }}
      >
        <div className="gi-palette__field">
          <UiIcon name="search" size={18} />
          <input
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label={placeholder}
            placeholder={placeholder}
            ref={fieldRef}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd keys={["Esc"]} />
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="gi-palette__results"
        >
          {results.map((r, i) => {
            const tint = r.node.layer ?? r.layer;
            const segments = highlightSegments(r.node.label, r.matches);
            const Name = isCode(r.node) ? "code" : "span";
            return (
              <li
                key={r.node.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className="gi-palette__result"
                onClick={() => onPick?.(r.node.id)}
                onMouseMove={() => i !== active && onActiveIndexChange?.(i)}
              >
                <IconTile layer={tint}>
                  <NodeIcon node={r.node} size={TILE_ICON_SIZE.sm} />
                </IconTile>
                <span className="gi-palette__text">
                  <Name className="gi-palette__name">
                    {segments.map((s, j) =>
                      s.match ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>,
                    )}
                  </Name>
                  {r.path && <code className="gi-palette__path">{r.path}</code>}
                </span>
                <span className="gi-palette__kind">
                  {kindName(r.node)}
                  {hidden?.has(r.node.id) && (
                    <span className="gi-palette__hidden">Hidden by filters</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {results.length === 0 && (
          <p className="gi-palette__empty" role="status">
            {empty !== undefined ? (
              empty
            ) : query ? (
              <>
                Nothing matches “{query}”. Try a route like <code>POST /api/orders</code> or a file
                name.
              </>
            ) : (
              "Type to search services, folders, files, functions, routes, pages, and models."
            )}
          </p>
        )}
        <footer className="gi-palette__footer" aria-hidden>
          <span>
            <Kbd keys={["↑", "↓"]} /> to move
          </span>
          <span>
            <Kbd keys={["Enter"]} /> to {pickVerb}
          </span>
          <span>
            <Kbd keys={["Esc"]} /> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
