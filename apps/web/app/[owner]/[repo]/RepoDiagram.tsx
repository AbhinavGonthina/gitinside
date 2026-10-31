"use client";

import {
  browserOnboarding,
  buildHierarchy,
  Button,
  createGitHubSourceLoader,
  decodeState,
  EmptyState,
  encodeState,
  Explorer,
  IconButton,
  ShareMenu,
  UiIcon,
  withState,
  type DecodedState,
  type ExplorerState,
  type ViewExport,
} from "@gitinside/viewer";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ignoredNote, shareUrl } from "../../../lib/deepLink";
import { headStatus, loadGraph, short, type GraphLoad } from "../../../lib/repoStatus";
import type { HeadState } from "../../../lib/repoView";
import { AddToReadme } from "./AddToReadme";
import { githubHref } from "./RepoNotice";
import { useAnalyze } from "./useAnalyze";

/** Props for {@link RepoDiagram}: a `ready` view from `viewRepo`. */
export interface RepoDiagramProps {
  /** GitHub's spelling, from the database. */
  owner: string;
  repo: string;
  sha: string;
  /** `/api/graph/…` of this commit. */
  graphUrl: string;
  head: HeadState;
}

/**
 * Starts the diagram's layout worker (`layoutWorker.ts`). Module-level, so the explorer's
 * engine isn't rebuilt on every render; only ever called in the browser.
 */
const layoutWorker = () =>
  new Worker(new URL("./layoutWorker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

/** The first-visit hints, remembered in this browser's `localStorage` (M4b.12a). */
const onboarding = browserOnboarding();

/**
 * The diagram page (ADR-0069): a repo bar (name, commit, how it relates to the latest
 * commit), then the diagram. The graph is fetched in the browser from `/api/graph`, so the
 * page itself stays small and the CDN caches the graph per commit. "Add to README" and the
 * share menu live on the repo bar, since the explorer's top bar is hidden. The diagram is the
 * M4b explorer without its top bar, laid out in a Web Worker (the explorer falls back to the
 * main thread if the worker can't start).
 *
 * Deep links (M4b.9b, ADR-0123): the explorer opens from the page's query (`decodeState`
 * against the loaded graph), and each change it reports replaces the query in place
 * (`history.replaceState`, no new history entry). What part of a link this commit doesn't
 * have is named in a note above the diagram. Copy link gives the commit's permalink with
 * the state. Export (M4b.10b) saves the view the explorer has drawn (its `exportRef`) as
 * SVG, PNG, or Mermaid, made in the browser.
 *
 * A graph that fails to load or parse (M4b.12b2) gets the explorer's empty-state card in the
 * error tone where the diagram goes: what happened, why or what to do, and Try again only when
 * another attempt could help. Focus moves to the card, so a keyboard or screen-reader user
 * lands on it.
 */
export function RepoDiagram({ owner, repo, sha, graphUrl, head }: RepoDiagramProps) {
  const [load, setLoad] = useState<GraphLoad | undefined>(undefined);
  // Bumped by "Try again".
  const [attempt, setAttempt] = useState(0);
  const failure = useRef<HTMLDivElement>(null);
  // The view on screen, kept by the explorer, for the share menu's Export.
  const exportRef = useRef<ViewExport | undefined>(undefined);
  const status = headStatus(owner, repo, head);
  const { analyze, busy, error } = useAnalyze(owner, repo);
  // Code previews read the public file at this commit straight from GitHub (ADR-0115).
  const loadSource = useMemo(
    () => createGitHubSourceLoader({ owner, name: repo, sha }),
    [owner, repo, sha],
  );

  // The page's link, read once per loaded graph: the explorer's initial props take it.
  const linked = useMemo<DecodedState | undefined>(
    () => (load?.ok ? decodeState(window.location.search, buildHierarchy(load.graph)) : undefined),
    [load],
  );
  // The state's query since the explorer last reported, for Copy link.
  const [query, setQuery] = useState<string>();
  const linkQuery = query ?? (linked ? encodeState(linked.state) : "");
  const [dismissed, setDismissed] = useState<DecodedState>();
  const note = linked && linked !== dismissed ? ignoredNote(linked.ignored, sha) : undefined;

  const onStateChange = (state: ExplorerState) => {
    const next = encodeState(state);
    setQuery(next);
    const { pathname, hash } = window.location;
    window.history.replaceState(window.history.state, "", withState(pathname, next) + hash);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoad(undefined);
    setQuery(undefined);
    loadGraph(graphUrl, { signal: controller.signal }).then(setLoad, () => {
      // aborted: the page moved on
    });
    return () => controller.abort();
  }, [graphUrl, attempt]);

  useEffect(() => {
    if (load && !load.ok) failure.current?.focus();
  }, [load]);

  return (
    <main className="diagram-page">
      <div className="repo-bar">
        <div className="repo-bar__title">
          <h1 className="repo-bar__name">
            <span className="notice__owner">{owner} /</span> {repo}
          </h1>
          <a
            className="gi-chip repo-bar__commit"
            href={githubHref(owner, repo, sha)}
            rel="noopener noreferrer"
            title={`Commit ${sha} on GitHub`}
          >
            <UiIcon name="commit" size={14} />
            <code>{short(sha)}</code>
          </a>
        </div>
        <p className="repo-bar__status" data-tone={status.tone}>
          <span>{status.text}</span>
          {status.link && <Link href={status.link.href}>{status.link.label}</Link>}
        </p>
        {status.analyze && (
          <Button variant="secondary" size="sm" onClick={analyze} aria-busy={busy || undefined}>
            Analyze again
          </Button>
        )}
        {error && (
          <p className="repo-bar__error" role="alert">
            {error}
          </p>
        )}
        <AddToReadme owner={owner} repo={repo} />
        <ShareMenu
          variant="secondary"
          size="sm"
          link={() => shareUrl(window.location.origin, owner, repo, sha, linkQuery)}
          exports={() => exportRef.current}
        />
        <a className="repo-bar__github" href={githubHref(owner, repo)} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </div>
      {note && (
        <div className="diagram-page__note">
          <p role="status">{note}</p>
          <IconButton icon="close" label="Dismiss" size="sm" onClick={() => setDismissed(linked)} />
        </div>
      )}
      <div className="diagram-page__canvas">
        {load === undefined ? (
          <p className="diagram-page__state" role="status">
            Loading the diagram
          </p>
        ) : load.ok ? (
          linked && (
            <Explorer
              graph={load.graph}
              topBar={false}
              layoutWorker={layoutWorker}
              loadSource={loadSource}
              initialOpen={linked.state.open}
              initialSelected={linked.state.selected}
              initialTrace={linked.state.trace}
              initialStep={linked.state.step}
              initialFilters={linked.state.filters}
              initialHiddenKinds={linked.state.hiddenKinds}
              onStateChange={onStateChange}
              exportRef={exportRef}
              onboarding={onboarding}
            />
          )
        ) : (
          <div className="diagram-page__state">
            <EmptyState
              ref={failure}
              title={load.title}
              tone="error"
              role="alert"
              tabIndex={-1}
              actions={
                load.retry ? (
                  <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                ) : undefined
              }
            >
              <p>{load.message}</p>
            </EmptyState>
          </div>
        )}
      </div>
    </main>
  );
}
