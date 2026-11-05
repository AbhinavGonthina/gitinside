"use client";

import { Button } from "@gitinside/viewer";
import Link from "next/link";
import { githubHref } from "./RepoNotice";
import { useAnalyze } from "./useAnalyze";

/**
 * A public repo nobody has analyzed yet (ADR-0068): one button that analyzes it, charged
 * to this visitor's hourly limit like the landing form. A refusal is said in place, and the
 * bot check (ADR-0157) runs under the button when the server asks for it.
 */
export function NotAnalyzed({ owner, repo }: { owner: string; repo: string }) {
  const { analyze, busy, error, asked, check } = useAnalyze(owner, repo);
  return (
    <main className="notice">
      <h1 className="notice__title">
        <span className="notice__owner">{owner} /</span> {repo}
      </h1>
      <p className="notice__text">
        This repo hasn&apos;t been analyzed yet. Analyzing reads its code, without running it, and
        builds the diagram.
      </p>
      {error && (
        <p className="progress__failure" role="alert">
          {error}
        </p>
      )}
      {asked && (
        <p className="progress__notice" role="status">
          {asked}
        </p>
      )}
      <div className="progress__actions">
        <Button variant="primary" onClick={analyze} aria-busy={busy || undefined}>
          Analyze
        </Button>
        <p className="notice__links">
          <Link href="/">Analyze another repo</Link>
          <a href={githubHref(owner, repo)} rel="noopener noreferrer">
            Open on GitHub
          </a>
        </p>
      </div>
      {check}
    </main>
  );
}
