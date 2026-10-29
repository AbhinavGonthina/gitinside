import Link from "next/link";
import { UNAVAILABLE_MESSAGE } from "../../../lib/messages";

/** The repo on GitHub, or one of its commits. */
export function githubHref(owner: string, repo: string, sha?: string): string {
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return sha === undefined ? base : `${base}/tree/${sha}`;
}

/**
 * The repo page when it can't look anything up (no database configured, or it failed):
 * UX.md's words for the worker being down, with the way back and the repo on GitHub.
 */
export function RepoUnavailable({ owner, repo }: { owner: string; repo: string }) {
  return (
    <main className="notice">
      <h1 className="notice__title">
        <span className="notice__owner">{owner} /</span> {repo}
      </h1>
      <p className="notice__text">{UNAVAILABLE_MESSAGE}</p>
      <p className="notice__links">
        <Link href="/">Analyze another repo</Link>
        <a href={githubHref(owner, repo)} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </p>
    </main>
  );
}
