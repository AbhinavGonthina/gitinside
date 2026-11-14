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
  type ExplorerState,
  summarizeGraph,
  TopBar,
} from "@gitinside/viewer";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadGraph, type GraphLoad } from "../../lib/repoStatus";

/** Props for {@link PrototypeDiagram}: one of `PROTOTYPE_REPOS`. */
export interface PrototypeDiagramProps {
  owner: string;
  repo: string;
  sha: string;
  /** `/api/prototype/graph/…` of the repo. */
  graphUrl: string;
  /** The page's own items at the end of the one bar (theme switch, sign-in). */
  barEnd?: ReactNode;
}

/** The commit chip's tooltip: the prototype draws each repo at a fixed commit. */
function pinnedText(sha: string): string {
  return `Commit ${sha}, pinned for the design review`;
}

/** The prototype's layout worker (`layoutWorker.ts`), started only in the browser. */
const layoutWorker = () =>
  new Worker(new URL("./layoutWorker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

/**
 * Whether this browser is done with the first-visit hint: the repo page's store and key
 * (M10-design B2 keeps both), so a reader who finished the tips there isn't shown the line.
 */
const onboarding = browserOnboarding();

/** The page's query with the explorer's state after `repo=`, which picks the repo. */
function prototypeQuery(owner: string, repo: string, state: string): string {
  const query = `repo=${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return `?${state === "" ? query : `${query}&${state.replace(/^\?/, "")}`}`;
}

/**
 * The M10 prototype's diagram (M10.3a): the real explorer, in its `"prototype"` design, over a
 * repo's stored production graph. Everything the explorer does works (pan, zoom, break down, trace,
 * search, filters, the inspector); the redesign's changes come in through `design`, so the shipped
 * repo page is untouched. The state goes in the address bar after `repo=`, as on the repo page, so
 * a click-through can be linked.
 */
export function PrototypeDiagram({ owner, repo, sha, graphUrl, barEnd }: PrototypeDiagramProps) {
  const status = { state: "current", text: pinnedText(sha) } as const;
  // Until the explorer draws (loading, or a load that failed), the same bar without actions, so
  // the page never has a second header or a jump in height.
  const bar = (
    <TopBar
      repo={{ owner, name: repo, sha }}
      actions={false}
      variant="page"
      home="/"
      status={status}
      end={barEnd}
    />
  );
  const [load, setLoad] = useState<GraphLoad>();
  const [attempt, setAttempt] = useState(0);
  const loadSource = useMemo(
    () => createGitHubSourceLoader({ owner, name: repo, sha }),
    [owner, repo, sha],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoad(undefined);
    loadGraph(graphUrl, { signal: controller.signal }).then(setLoad, () => {
      // aborted: the page moved on
    });
    return () => controller.abort();
  }, [graphUrl, attempt]);

  // Decoded against the graph the prototype draws, its groups included (M10.3b1), so a link
  // that opens "Shared packages" opens it again.
  const linked = useMemo(
    () =>
      load?.ok
        ? decodeState(window.location.search, buildHierarchy(summarizeGraph(load.graph)))
        : undefined,
    [load],
  );

  const onStateChange = (state: ExplorerState) => {
    const { pathname, hash } = window.location;
    const page = pathname + prototypeQuery(owner, repo, encodeState(state)) + hash;
    window.history.replaceState(window.history.state, "", page);
  };

  return (
    // `data-own-header`: the explorer's bar is the page's one bar, so the site header isn't drawn
    // (globals.css, M10-design A7).
    <main className="diagram-page" data-own-header="">
      {/* The heading is for screen readers. */}
      <h1 className="visually-hidden">
        Design prototype: {owner} / {repo}
      </h1>
      {!(load?.ok && linked) && bar}
      <div className="diagram-page__canvas">
        {load === undefined ? (
          <p className="diagram-page__state" role="status">
            Loading the diagram
          </p>
        ) : load.ok ? (
          linked && (
            <Explorer
              graph={load.graph}
              design="prototype"
              home="/"
              commitStatus={status}
              topBarEnd={barEnd}
              layoutWorker={layoutWorker}
              loadSource={loadSource}
              onboarding={onboarding}
              initialOpen={linked.state.open}
              initialSelected={linked.state.selected}
              initialTrace={linked.state.trace}
              initialStep={linked.state.step}
              initialFilters={linked.state.filters}
              initialHiddenKinds={linked.state.hiddenKinds}
              onStateChange={onStateChange}
              linkTo={(query) =>
                `${window.location.origin}${window.location.pathname}${prototypeQuery(owner, repo, query)}`
              }
            />
          )
        ) : (
          <div className="diagram-page__state">
            <EmptyState
              title={load.title}
              tone="error"
              role="alert"
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
