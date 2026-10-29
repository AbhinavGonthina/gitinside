import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseRepoPath } from "../../../../lib/repoUrl";
import { repoScreen } from "../repoScreen";

/** Route params for `/<owner>/<repo>/<sha>`. */
interface Params {
  owner: string;
  repo: string;
  sha: string;
}

/** Permalinks take the full 40-character SHA, lowercase, as the API and GitHub's links do. */
const SHA = /^[0-9a-f]{40}$/;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo, sha } = await params;
  const ref = parseRepoPath(owner, repo);
  return ref && SHA.test(sha) ? { title: `${ref.owner}/${ref.repo} at ${sha.slice(0, 7)}` } : {};
}

/**
 * A commit's permalink: always that commit's diagram, never checked against GitHub
 * (ADR-0068). A commit nobody analyzed, or anything but a full SHA, is a 404.
 */
export default async function CommitPage({ params }: { params: Promise<Params> }) {
  const { owner, repo, sha } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref || !SHA.test(sha)) notFound();
  return repoScreen(ref, sha);
}
