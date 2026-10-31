import type { HTMLAttributes, ReactNode } from "react";
import { Button, Kbd, SegmentedControl, type Segment } from "./controls.js";
import { shortSha, type RepoRef } from "./describe.js";
import { LogoMark, UiIcon } from "./uiIcons.js";

/** The three ways to look at a diff (UX.md "Diff mode"). */
export type DiffView = "base" | "head" | "overlay";

/** The diff view choices, in the order the top bar shows them. */
export const DIFF_VIEWS: readonly Segment<DiffView>[] = [
  { value: "base", label: "Base" },
  { value: "head", label: "Head" },
  { value: "overlay", label: "Overlay" },
];

/** Props for {@link TopBar}. */
export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  repo: RepoRef;
  /** The branch or ref the user asked for, shown before the SHA when known. */
  branch?: string | undefined;
  /** Shows "⌘ K" instead of "Ctrl K". */
  mac?: boolean;
  /** Opens the command palette. */
  onSearch?: (() => void) | undefined;
  /** Shown only when there is a base to compare against. */
  diff?: { value: DiffView; onChange?: ((view: DiffView) => void) | undefined } | undefined;
  /** How many filters are active, shown on the Filters button. */
  filterCount?: number;
  /** The filters popover is open (the button's `aria-expanded`); unset when there's none. */
  filtersOpen?: boolean | undefined;
  onFilters?: (() => void) | undefined;
  onShare?: (() => void) | undefined;
  /** Drawn in place of the Share button, e.g. a `ShareMenu` with its own button. */
  share?: ReactNode;
  /** A trace is running: the trace button becomes "Exit trace". */
  tracing?: boolean;
  onTrace?: (() => void) | undefined;
  /**
   * Draw the search field and the actions (default). Off when there's no
   * diagram to search, filter, share, or trace: the mark and repo stay.
   */
  actions?: boolean;
}

/**
 * The explorer's top bar (UX.md "Layout"): the mark, the repo and the commit
 * it was analyzed at, the search field that opens the command palette, and
 * the actions (diff view, filters, share, trace). Quiet by design; "Trace a
 * request" is the only primary button, because trace is the signature
 * interaction.
 */
export function TopBar({
  repo,
  branch,
  mac = false,
  onSearch,
  diff,
  filterCount = 0,
  filtersOpen,
  onFilters,
  onShare,
  share,
  tracing = false,
  onTrace,
  actions = true,
  className,
  ...rest
}: TopBarProps) {
  const mod = mac ? "⌘" : "Ctrl";
  if (!actions) {
    return (
      <header
        {...rest}
        className={className ? `gi-topbar ${className}` : "gi-topbar"}
        data-actions="none"
      >
        <TopBarStart repo={repo} branch={branch} />
      </header>
    );
  }
  return (
    <header {...rest} className={className ? `gi-topbar ${className}` : "gi-topbar"}>
      <TopBarStart repo={repo} branch={branch} />
      <button
        type="button"
        className="gi-search-field"
        onClick={onSearch}
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      >
        <UiIcon name="search" />
        <span className="gi-search-field__placeholder">Search services, files, routes</span>
        <Kbd keys={[mod, "K"]} />
      </button>
      <div className="gi-topbar__end">
        {diff && (
          <SegmentedControl
            label="Diff view"
            options={DIFF_VIEWS}
            value={diff.value}
            onChange={diff.onChange}
          />
        )}
        <Button
          variant="quiet"
          icon="filter"
          className="gi-topbar__filters"
          aria-expanded={filtersOpen}
          onClick={onFilters}
        >
          Filters
          {filterCount > 0 && <span className="gi-count">{filterCount}</span>}
        </Button>
        {share ?? (
          <Button variant="quiet" icon="share" onClick={onShare}>
            Share
          </Button>
        )}
        <Button
          variant={tracing ? "secondary" : "primary"}
          icon={tracing ? "close" : "trace"}
          shortcut={["T"]}
          aria-keyshortcuts="T"
          onClick={onTrace}
        >
          {tracing ? "Exit trace" : "Trace a request"}
        </Button>
      </div>
    </header>
  );
}

/** The top bar's start: the wordmark, then the repo and the commit (or branch) it was analyzed at. */
function TopBarStart({ repo, branch }: { repo: RepoRef; branch: string | undefined }) {
  return (
    <div className="gi-topbar__start">
      <span className="gi-wordmark">
        <LogoMark />
        <span>GitInside</span>
      </span>
      <span className="gi-topbar__divider" aria-hidden />
      <span className="gi-repo">
        <span className="gi-repo__name">
          <span className="gi-repo__owner">{repo.owner} /</span> {repo.name}
        </span>
        {(branch ?? repo.sha) && (
          <span className="gi-chip" title={repo.sha ? `Commit ${repo.sha}` : undefined}>
            <UiIcon name="commit" size={14} />
            {branch && <span>{branch}</span>}
            {repo.sha && <code>{shortSha(repo.sha)}</code>}
          </span>
        )}
      </span>
    </div>
  );
}
