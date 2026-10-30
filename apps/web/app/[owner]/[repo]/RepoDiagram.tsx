"use client";

import { Button, createGitHubSourceLoader, Explorer, UiIcon } from "@gitinside/viewer";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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

/**
 * The diagram page (ADR-0069): a repo bar (name, commit, how it relates to the latest
 * commit), then the diagram. The graph is fetched in the browser from `/api/graph`, so the
 * page itself stays small and the CDN caches the graph per commit. "Add to README" lives on
 * the repo bar, since the explorer's share menu is hidden with its top bar. The diagram is the
 * M4b explorer without its top bar, laid out in a Web Worker (the explorer falls back to the
 * main thread if the worker can't start).
 */
export function RepoDiagram({ owner, repo, sha, graphUrl, head }: RepoDiagramProps) {
  const [load, setLoad] = useState<GraphLoad | undefined>(undefined);
  // Bumped by "Try again".
  const [attempt, setAttempt] = useState(0);
  const failure = useRef<HTMLParagraphElement>(null);
  const status = headStatus(owner, repo, head);
  const { analyze, busy, error } = useAnalyze(owner, repo);
  // Code previews read the public file at this commit straight from GitHub (ADR-0115).
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
        <a className="repo-bar__github" href={githubHref(owner, repo)} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </div>
      <div className="diagram-page__canvas">
        {load === undefined ? (
          <p className="diagram-page__state" role="status">
            Loading the diagram
          </p>
        ) : load.ok ? (
          <Explorer
            graph={load.graph}
            topBar={false}
            layoutWorker={layoutWorker}
            loadSource={loadSource}
          />
        ) : (
          <div className="diagram-page__state">
            <p className="progress__failure" role="alert" tabIndex={-1} ref={failure}>
              {load.message}
            </p>
            {load.retry && (
              <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
