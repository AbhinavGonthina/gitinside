import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMMIT_SHA, type SearchParams } from "../../../../../lib/compare";
import { ANALYZE_JOB_ID } from "../../../../../lib/jobRoute";
import { parseRepoPath } from "../../../../../lib/repoUrl";
import { COMMIT_PARAM } from "../../../../../lib/startAnalysis";
import { JobProgress } from "./JobProgress";

/** Route params for `/<owner>/<repo>/jobs/<job>`. */
interface Params {
  owner: string;
  repo: string;
  job: string;
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { owner, repo, job } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref || !ANALYZE_JOB_ID.test(job)) return {};
  // A progress page is one visitor's moment, not something to index.
  return { title: `Analyzing ${ref.owner}/${ref.repo}`, robots: { index: false } };
}

/**
 * The progress page (UX.md "Analyze", ADR-0067): where `/api/analyze` sends a visitor whose
 * commit was queued. The live part is {@link JobProgress}; this page only checks the path.
 * Names GitHub wouldn't allow and IDs the worker could never issue are a 404, never echoed.
 * `?commit=<sha>` (a demo pin's permalink, ADR-0255) opens that commit when done; a value that
 * isn't one full SHA is ignored, so the page opens the repo page as usual.
 */
export default async function ProgressPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams?: Promise<SearchParams>;
}) {
  const { owner, repo, job } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref || !ANALYZE_JOB_ID.test(job)) notFound();
  const commit = (await searchParams)?.[COMMIT_PARAM];
  return (
    <JobProgress
      owner={ref.owner}
      repo={ref.repo}
      jobId={job}
      commit={typeof commit === "string" && COMMIT_SHA.test(commit) ? commit : undefined}
    />
  );
}
