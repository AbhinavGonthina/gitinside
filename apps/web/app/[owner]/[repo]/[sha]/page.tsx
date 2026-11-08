import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMMIT_SHA, type SearchParams } from "../../../../lib/compare";
import { parseRepoPath } from "../../../../lib/repoUrl";
import { repoMetadata, repoScreen } from "../repoScreen";

/** Route params for `/<owner>/<repo>/<sha>`. */
interface Params {
  owner: string;
  repo: string;
  sha: string;
}

/** The tab's title; a private repo shown to its viewer isn't indexed (M8.4c1). */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo, sha } = await params;
  const ref = parseRepoPath(owner, repo);
  return ref && COMMIT_SHA.test(sha) ? repoMetadata(ref, sha) : {};
}

/**
 * A commit's permalink: always that commit's diagram, never checked against GitHub
 * (ADR-0068). A commit nobody analyzed, or anything but a full SHA, is a 404.
 * Permalinks take the full 40-character SHA, lowercase, as the API and GitHub's links do.
 * `?base=<sha>` compares it with that commit (diff mode, ADR-0189).
 */
export default async function CommitPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams?: Promise<SearchParams>;
}) {
  const { owner, repo, sha } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref || !COMMIT_SHA.test(sha)) notFound();
  return repoScreen(ref, sha, await searchParams);
}
