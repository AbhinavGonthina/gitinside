import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseRepoPath } from "../../../lib/repoUrl";
import { repoScreen } from "./repoScreen";

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
 * A repo's page: the diagram of its latest analyzed commit, with check-on-view re-analysis
 * when the default branch has moved on (lib/repoView.ts, ADR-0068), or an "Analyze" button
 * if nobody has analyzed it. Names that GitHub wouldn't allow are a 404, never echoed back.
 */
export default async function RepoPage({ params }: { params: Promise<Params> }) {
  const { owner, repo } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref) notFound();
  return repoScreen(ref);
}
