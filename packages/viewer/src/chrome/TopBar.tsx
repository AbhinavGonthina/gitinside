import type { HTMLAttributes, ReactNode } from "react";
import { Button, Kbd, SegmentedControl, type Segment } from "./controls.js";
import { shortSha, type RepoRef } from "./describe.js";
import { Breadcrumbs, type Crumb } from "./overlays.js";
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
  /**
   * `"explorer"` (default) is the explorer's own bar. `"page"` is the M10 redesign's one bar for
   * a whole page (M10-design A7, M10.3c1): the mark alone, linking `home`; the commit chip with
   * `status`'s dot, linking the commit on GitHub; the drill-down path (`crumbs`) after `›`;
   * "Search the diagram"; Trace, Filters, and Share; then the page's own `end` (theme, sign-in).
   * Narrow, the search field and then Trace shrink to icons, their names kept for screen readers.
   */
  variant?: "explorer" | "page";
  /** Where the mark links (`"page"` only). */
  home?: string | undefined;
  /** The drill-down path, drawn after the repo (`"page"` only). */
  crumbs?: readonly Crumb[] | undefined;
  /** Go up to a level of `crumbs`. */
  onCrumb?: ((id: string) => void) | undefined;
  /** The commit chip's dot: is this diagram the latest commit's (`"page"` only)? */
  status?: CommitStatus | undefined;
  /** The page's own items at the end of the bar (`"page"` only). */
  end?: ReactNode;
}

/**
 * What the commit chip's dot says (M10-design B12): `current`, the diagram is of the commit the
 * page asked for (green); `analyzing`, a newer commit is being analyzed (amber, "newer
 * analyzing"); `ready`, it's done, and a button shows it. `text` is the full sentence, in the
 * chip's tooltip and, for the last two, a live region.
 */
export type CommitStatus =
  | { state: "current" | "analyzing"; text: string }
  | { state: "ready"; text: string; sha: string; onShow: () => void };

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
  variant = "explorer",
  home,
  crumbs,
  onCrumb,
  status,
  end,
  className,
  ...rest
}: TopBarProps) {
  const mod = mac ? "⌘" : "Ctrl";
  const page = variant === "page";
  const classes = className ? `gi-topbar ${className}` : "gi-topbar";
  const start = page ? (
    <PageStart repo={repo} home={home} crumbs={crumbs} onCrumb={onCrumb} status={status} />
  ) : (
    <TopBarStart repo={repo} branch={branch} />
  );
  if (!actions) {
    return (
      <header
        {...rest}
        className={classes}
        data-actions="none"
        data-variant={page ? "page" : undefined}
      >
        {start}
        {page && end !== undefined && <div className="gi-topbar__end">{end}</div>}
      </header>
    );
  }
  const searchLabel = page ? "Search the diagram" : "Search services, files, routes";
  const trace = (
    <Button
      variant={tracing ? "secondary" : "primary"}
      icon={tracing ? "close" : "trace"}
      className="gi-topbar__trace"
      shortcut={["T"]}
      aria-keyshortcuts="T"
      title={page ? (tracing ? "Exit trace (T)" : "Trace a request (T)") : undefined}
      onClick={onTrace}
    >
      {tracing ? "Exit trace" : "Trace a request"}
    </Button>
  );
  return (
    <header {...rest} className={classes} data-variant={page ? "page" : undefined}>
      {start}
      <button
        type="button"
        className="gi-search-field"
        onClick={onSearch}
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        aria-label={page ? searchLabel : undefined}
        title={page ? `${searchLabel} (${mod} K)` : undefined}
      >
        <UiIcon name="search" />
        <span className="gi-search-field__placeholder">{searchLabel}</span>
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
        {page && trace}
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
        {!page && trace}
        {page && end}
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

/** The path's top level in the page bar, where the repo's name is already just before it. */
export const SYSTEM_CRUMB = "System";

/** The commit's page on GitHub. */
export function commitUrl(repo: RepoRef & { sha: string }): string {
  const part = encodeURIComponent;
  return `https://github.com/${part(repo.owner)}/${part(repo.name)}/commit/${part(repo.sha)}`;
}

/**
 * The page bar's start (M10-design A7): the mark (home), the repo, the commit chip with its
 * status dot, and the drill-down path. The path's levels above the current one go up to it.
 */
function PageStart({
  repo,
  home,
  crumbs,
  onCrumb,
  status,
}: Pick<TopBarProps, "repo" | "home" | "crumbs" | "onCrumb" | "status">) {
  const mark = <LogoMark size={22} />;
  const sha = repo.sha;
  const announced = status !== undefined && status.state !== "current";
  return (
    <div className="gi-topbar__start">
      {home !== undefined ? (
        <a className="gi-topbar__home" href={home} aria-label="GitInside home">
          {mark}
        </a>
      ) : (
        <span className="gi-topbar__home" role="img" aria-label="GitInside">
          {mark}
        </span>
      )}
      <span className="gi-repo">
        <span className="gi-repo__name">
          <span className="gi-repo__owner">{repo.owner} /</span> {repo.name}
        </span>
        {sha !== undefined && (
          <a
            className="gi-chip gi-commit"
            href={commitUrl({ ...repo, sha })}
            title={status?.text ?? `Commit ${sha}`}
            data-status={status?.state}
          >
            <code>{shortSha(sha)}</code>
            {status?.state === "analyzing" && <span>· newer analyzing</span>}
            {status !== undefined && <span className="gi-chip__dot" aria-hidden />}
          </a>
        )}
        {status?.state === "ready" && (
          <Button variant="quiet" size="sm" className="gi-commit__show" onClick={status.onShow}>
            Show {shortSha(status.sha)}
          </Button>
        )}
        {/* Always there, so a change of status is announced (a region added with its text isn't). */}
        <span className="gi-visually-hidden" role="status">
          {announced ? status.text : ""}
        </span>
      </span>
      {crumbs !== undefined && crumbs.length > 0 && (
        <>
          <UiIcon name="chevron-right" size={14} />
          <Breadcrumbs
            className="gi-topbar__crumbs"
            items={crumbs.map((c, i) => (i === 0 ? { ...c, label: SYSTEM_CRUMB } : c))}
            onSelect={onCrumb}
          />
        </>
      )}
    </div>
  );
}
