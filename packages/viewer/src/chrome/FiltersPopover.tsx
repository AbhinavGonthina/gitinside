import type { Confidence, EdgeKind, Layer, NodeKind } from "@gitinside/schema";
import { useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent } from "react";
import { CONFIDENCE_TEXT } from "../edges/describe.js";
import {
  normalizeFolder,
  type FilterOption,
  type FilterOptions,
  type Filters,
} from "../model/filters.js";
import { Button, IconButton, Toggle } from "./controls.js";
import { LAYER_NAMES } from "./describe.js";

/** Node kinds in the popover's words (only the kinds `FILTER_KINDS` offers are shown). */
export const KIND_PLURALS: Readonly<Partial<Record<NodeKind, string>>> = {
  route: "Routes",
  page: "Pages",
  symbol: "Functions and classes",
  model: "Models",
  datastore: "Datastores",
  queue: "Queues",
  external: "Outside APIs",
  unresolved: "Unresolved calls",
};

/** Connection kinds in the popover's words. A record over every kind, so a new one can't miss its name. */
export const CONNECTION_NAMES: Readonly<Record<EdgeKind, string>> = {
  imports: "Imports",
  calls: "Calls",
  http: "HTTP requests",
  handles: "Route handlers",
  renders: "Renders",
  reads: "Reads",
  writes: "Writes",
  stores: "Model storage",
  publishes: "Queue publishes",
  consumes: "Queue consumers",
  external_call: "Outside API calls",
};

/** Props for {@link FiltersPopover}. */
export interface FiltersPopoverProps extends Omit<HTMLAttributes<HTMLElement>, "onChange"> {
  /** What the graph has to filter, with counts (`filterOptions`). */
  options: FilterOptions;
  filters: Filters;
  /** Connection kinds left off (imports by default). */
  hiddenKinds: ReadonlySet<EdgeKind>;
  onFiltersChange?: ((filters: Filters) => void) | undefined;
  onHiddenKindsChange?: ((kinds: ReadonlySet<EdgeKind>) => void) | undefined;
  /** Shows everything the filters hide; unset (or nothing to clear) disables Clear. */
  onClear?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  /** `"closing"` while it plays its exit (`usePresence`); it's inert then. Default `"open"`. */
  state?: "open" | "closing" | undefined;
  /** Move focus to its first control on every open. */
  autoFocus?: boolean | undefined;
}

/** A row of on/off choices: each a pressed button while what it names is shown. */
function Choices<T extends string>({
  title,
  options,
  name,
  shown,
  onToggle,
}: {
  title: string;
  options: readonly FilterOption<T>[];
  name: (value: T) => string;
  shown: (value: T) => boolean;
  onToggle: (value: T) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="gi-filters__group" role="group" aria-label={title}>
      <h3>{title}</h3>
      <div className="gi-filters__choices">
        {options.map(({ value, count }) => (
          <button
            key={value}
            type="button"
            className="gi-filters__choice"
            aria-pressed={shown(value)}
            onClick={() => onToggle(value)}
          >
            <span>{name(value)}</span>
            <span className="gi-filters__count">{count.toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A list with `value` added, or taken out if it's there. */
function flip<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * The filters popover (M4b.8b, UX.md "Filters"): "Hide tests and config",
 * then on/off choices for layers, node kinds, connection kinds (imports
 * included), and confidence, each with how many the graph has (only what it
 * has is offered), and a folder field to show one folder alone or hide it.
 * A choice is pressed while what it names is shown. A folder that isn't in
 * the graph is refused with a message rather than filtering nothing. It's
 * a non-modal popover: Esc or the close button closes it. Focus never drops
 * out of it to the page (M4b.15d): Clear moves it to the tests switch as it
 * turns itself off, and a folder chip's remove button to the next chip, the
 * one before, or the folder field.
 */
export function FiltersPopover({
  options,
  filters,
  hiddenKinds,
  onFiltersChange,
  onHiddenKindsChange,
  onClear,
  onClose,
  state = "open",
  autoFocus = false,
  className,
  ...rest
}: FiltersPopoverProps) {
  const id = useId();
  const [folder, setFolder] = useState("");
  const [problem, setProblem] = useState<string>();
  // Focus on every open, also when reopened mid-exit (the same element).
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus && state === "open")
      root.current?.querySelector<HTMLElement>("[role=switch]")?.focus();
  }, [autoFocus, state]);

  const change = (patch: Partial<Filters>) => onFiltersChange?.({ ...filters, ...patch });
  const known = new Set(options.folders);
  const addFolder = (list: "include" | "exclude") => {
    const path = normalizeFolder(folder);
    if (path === "") return;
    if (!known.has(path)) {
      setProblem(`No folder ${path} in this repo.`);
      return;
    }
    setProblem(undefined);
    setFolder("");
    change({ [list]: filters[list].includes(path) ? filters[list] : [...filters[list], path] });
  };
  const onFolderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addFolder("exclude");
  };
  // Clear turns itself off and a folder chip's button goes with it, so focus on
  // either moves first (to a control that stays) rather than being lost.
  const hasFocus = () => root.current?.contains(document.activeElement) ?? false;
  const clear = () => {
    if (hasFocus()) root.current?.querySelector<HTMLElement>("[role=switch]")?.focus();
    onClear?.();
  };
  /** Takes a folder chip off: focus goes to the next chip, else the one before, else the field. */
  const removeFolder = (button: HTMLElement, patch: Partial<Filters>) => {
    if (hasFocus()) {
      const chips = [
        ...(root.current?.querySelectorAll<HTMLElement>(".gi-filters__folders button") ?? []),
      ];
      const at = chips.indexOf(button);
      (
        chips[at + 1] ??
        chips[at - 1] ??
        root.current?.querySelector<HTMLElement>(".gi-filters__field")
      )?.focus();
    }
    change(patch);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose?.();
  };

  return (
    <section
      ref={root}
      aria-label="Filters"
      {...rest}
      className={className ? `gi-popover gi-filters ${className}` : "gi-popover gi-filters"}
      data-state={state}
      inert={state === "closing" || undefined}
      aria-hidden={state === "closing" || undefined}
      onKeyDown={onKeyDown}
    >
      <header className="gi-popover__header">
        <h2>Filters</h2>
        <span className="gi-filters__actions">
          <Button variant="quiet" size="sm" disabled={!onClear} onClick={clear}>
            Clear
          </Button>
          {onClose && <IconButton icon="close" label="Close filters" size="sm" onClick={onClose} />}
        </span>
      </header>
      <Toggle
        className="gi-filters__tests"
        checked={filters.hideTestsAndConfig}
        onChange={(hideTestsAndConfig) => change({ hideTestsAndConfig })}
      >
        Hide tests and config
      </Toggle>
      <Choices<Layer>
        title="Layers"
        options={options.layers}
        name={(l) => LAYER_NAMES[l]}
        shown={(l) => !filters.layers.includes(l)}
        onToggle={(l) => change({ layers: flip(filters.layers, l) })}
      />
      <Choices<NodeKind>
        title="Kinds"
        options={options.kinds}
        name={(k) => KIND_PLURALS[k] ?? k}
        shown={(k) => !filters.kinds.includes(k)}
        onToggle={(k) => change({ kinds: flip(filters.kinds, k) })}
      />
      <Choices<EdgeKind>
        title="Connections"
        options={options.edgeKinds}
        name={(k) => CONNECTION_NAMES[k]}
        shown={(k) => !hiddenKinds.has(k)}
        onToggle={(k) => onHiddenKindsChange?.(new Set(flip([...hiddenKinds], k)))}
      />
      <Choices<Confidence>
        title="Confidence"
        options={options.confidence}
        name={(c) => CONFIDENCE_TEXT[c]}
        shown={(c) => !filters.confidence.includes(c)}
        onToggle={(c) => change({ confidence: flip(filters.confidence, c) })}
      />
      {options.folders.length > 0 && (
        <div className="gi-filters__group" role="group" aria-label="Folders">
          <h3>
            <label htmlFor={`${id}-folder`}>Folders</label>
          </h3>
          <div className="gi-filters__folder">
            <input
              id={`${id}-folder`}
              className="gi-filters__field"
              list={`${id}-folders`}
              placeholder="apps/web/app"
              spellCheck={false}
              autoComplete="off"
              aria-describedby={problem ? `${id}-problem` : undefined}
              aria-invalid={problem ? true : undefined}
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                setProblem(undefined);
              }}
              onKeyDown={onFolderKey}
            />
            <datalist id={`${id}-folders`}>
              {options.folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <Button size="sm" onClick={() => addFolder("include")}>
              Show only
            </Button>
            <Button size="sm" onClick={() => addFolder("exclude")}>
              Hide
            </Button>
          </div>
          {problem && (
            <p id={`${id}-problem`} className="gi-filters__problem" role="status">
              {problem}
            </p>
          )}
          {(filters.include.length > 0 || filters.exclude.length > 0) && (
            <ul className="gi-filters__folders">
              {filters.include.map((f) => (
                <li key={`include:${f}`}>
                  <span>
                    Only <code>{f}</code>
                  </span>
                  <IconButton
                    icon="close"
                    size="sm"
                    label={`Stop showing only ${f}`}
                    onClick={(e) =>
                      removeFolder(e.currentTarget, {
                        include: filters.include.filter((x) => x !== f),
                      })
                    }
                  />
                </li>
              ))}
              {filters.exclude.map((f) => (
                <li key={`exclude:${f}`}>
                  <span>
                    Hiding <code>{f}</code>
                  </span>
                  <IconButton
                    icon="close"
                    size="sm"
                    label={`Show ${f} again`}
                    onClick={(e) =>
                      removeFolder(e.currentTarget, {
                        exclude: filters.exclude.filter((x) => x !== f),
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
