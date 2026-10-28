import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ANALYZE_JOB_ID } from "../../../../../lib/jobRoute";
import { parseRepoPath } from "../../../../../lib/repoUrl";
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
 */
export default async function ProgressPage({ params }: { params: Promise<Params> }) {
  const { owner, repo, job } = await params;
  const ref = parseRepoPath(owner, repo);
  if (!ref || !ANALYZE_JOB_ID.test(job)) notFound();
  return <JobProgress owner={ref.owner} repo={ref.repo} jobId={job} />;
}
