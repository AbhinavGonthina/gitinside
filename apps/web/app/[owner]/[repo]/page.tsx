import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { parseRepoPath } from "../../../lib/repoUrl";

/** Route params for `/<owner>/<repo>`. */
interface Params {
  owner: string;
  repo: string;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo } = await params;
  const ref = parseRepoPath(owner, repo);
  return ref ? { title: `${ref.owner}/${ref.repo}` } : {};
}

/**
 * A repo's page. M5.8 turns this into the diagram (with check-on-view
 * re-analysis); until the worker and storage exist (M5.4–M5.6), it says
 * plainly that analysis isn't available, in UX.md's words for that state.
 * Names that GitHub wouldn't allow are a 404, never echoed back.
 */
export default async function RepoPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref) notFound();
  const github = `https://github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  return (
    <main className="notice">
      <h1 className="notice__title">
        <span className="notice__owner">{ref.owner} /</span> {ref.repo}
      </h1>
      <p className="notice__text">
        Analysis is temporarily unavailable. Already-analyzed repos still work.
      </p>
      <p className="notice__links">
        <Link href="/">Analyze another repo</Link>
        <a href={github} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </p>
    </main>
  );
}
