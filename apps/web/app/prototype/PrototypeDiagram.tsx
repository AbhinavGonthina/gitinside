"use client";

import {
  buildHierarchy,
  Button,
  createGitHubSourceLoader,
  decodeState,
  EmptyState,
  encodeState,
  Explorer,
  type ExplorerState,
} from "@gitinside/viewer";
import { useEffect, useMemo, useState } from "react";
import { loadGraph, type GraphLoad } from "../../lib/repoStatus";

/** Props for {@link PrototypeDiagram}: one of `PROTOTYPE_REPOS`. */
export interface PrototypeDiagramProps {
  owner: string;
  repo: string;
  sha: string;
  /** `/api/prototype/graph/…` of the repo. */
  graphUrl: string;
}

/** The prototype's layout worker (`layoutWorker.ts`), started only in the browser. */
const layoutWorker = () =>
  new Worker(new URL("./layoutWorker.ts", import.meta.url), {
    type: "module",
    name: "gitinside-layout",
  });

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
export function PrototypeDiagram({ owner, repo, sha, graphUrl }: PrototypeDiagramProps) {
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

  const linked = useMemo(
    () => (load?.ok ? decodeState(window.location.search, buildHierarchy(load.graph)) : undefined),
    [load],
  );

  const onStateChange = (state: ExplorerState) => {
    const { pathname, hash } = window.location;
    const page = pathname + prototypeQuery(owner, repo, encodeState(state)) + hash;
    window.history.replaceState(window.history.state, "", page);
  };

  return (
    <main className="diagram-page">
      {/* The explorer's own top bar names the repo and commit, so the page adds no second bar
          (M10-design A7); the heading is for screen readers. */}
      <h1 className="visually-hidden">
        Design prototype: {owner} / {repo}
      </h1>
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
              layoutWorker={layoutWorker}
              loadSource={loadSource}
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
