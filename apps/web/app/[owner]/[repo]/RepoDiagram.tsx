"use client";

import { Button, Explorer, UiIcon } from "@gitinside/viewer";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
 * The diagram page (ADR-0069): a repo bar (name, commit, how it relates to the latest
 * commit), then the diagram. The graph is fetched in the browser from `/api/graph`, so the
 * page itself stays small and the CDN caches the graph per commit. "Add to README" lives on
 * the repo bar, since the explorer's share menu is hidden with its top bar. The diagram is the
 * M4b explorer without its top bar; its layouts run on the main thread until M4b.3b2 gives the
 * site a layout worker.
 */
export function RepoDiagram({ owner, repo, sha, graphUrl, head }: RepoDiagramProps) {
  const [load, setLoad] = useState<GraphLoad | undefined>(undefined);
  // Bumped by "Try again".
  const [attempt, setAttempt] = useState(0);
  const failure = useRef<HTMLParagraphElement>(null);
  const status = headStatus(owner, repo, head);
  const { analyze, busy, error } = useAnalyze(owner, repo);

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
          <Explorer graph={load.graph} topBar={false} />
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
