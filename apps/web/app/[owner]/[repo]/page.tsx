import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { SearchParams } from "../../../lib/compare";
import { parseRepoPath } from "../../../lib/repoUrl";
import { repoMetadata, repoScreen } from "./repoScreen";

/** Route params for `/<owner>/<repo>`. */
interface Params {
  owner: string;
  repo: string;
}

/** The tab's title; a private repo shown to its viewer isn't indexed (M8.4c1). */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo } = await params;
  const ref = parseRepoPath(owner, repo);
  return ref ? repoMetadata(ref) : {};
}

/**
 * A repo's page: the diagram of its latest analyzed commit, with check-on-view re-analysis
 * when the default branch has moved on (lib/repoView.ts, ADR-0068), or an "Analyze" button
 * if nobody has analyzed it. Names that GitHub wouldn't allow are a 404, never echoed back.
 * `?base=<sha>` compares it with that commit (diff mode, ADR-0189).
 */
export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams?: Promise<SearchParams>;
}) {
  const { owner, repo } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref) notFound();
  return repoScreen(ref, undefined, await searchParams);
}
