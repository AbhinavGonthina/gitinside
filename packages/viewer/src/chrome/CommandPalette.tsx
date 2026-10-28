import type { GraphNode, Layer } from "@gitinside/schema";
import { useId, type KeyboardEvent } from "react";
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
 * Enter opens it, Esc closes. Fuzzy matching itself is M4b.7; this draws
 * whatever results it is given.
 */
export function CommandPalette({
  query,
  results,
  activeIndex = 0,
  onQueryChange,
  onActiveIndexChange,
  onPick,
  onClose,
}: CommandPaletteProps) {
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (i: number) => `${id}-option-${i}`;
  const active = results.length ? Math.min(Math.max(activeIndex, 0), results.length - 1) : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const n = results.length;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
    } else if (n && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      onActiveIndexChange?.((active + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      onPick?.((results[active] as PaletteResult).node.id);
    }
  };

  return (
    <div className="gi-palette-scrim" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the diagram"
        className="gi-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gi-palette__field">
          <UiIcon name="search" size={18} />
          <input
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label="Search services, files, routes"
            placeholder="Search services, files, routes"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => onQueryChange?.(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd keys={["Esc"]} />
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="gi-palette__results">
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
                <span className="gi-palette__kind">{kindName(r.node)}</span>
              </li>
            );
          })}
        </ul>
        {results.length === 0 && (
          <p className="gi-palette__empty" role="status">
            {query ? (
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
            <Kbd keys={["Enter"]} /> to open
          </span>
          <span>
            <Kbd keys={["Esc"]} /> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
