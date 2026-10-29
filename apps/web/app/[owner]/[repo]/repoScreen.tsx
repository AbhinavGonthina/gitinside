import { notFound } from "next/navigation";
import type { RepoRef } from "../../../lib/repoUrl";
import { viewRepo } from "../../../lib/repoView";
import { repoViewDepsFromEnv } from "../../../lib/serverDeps";
import { NotAnalyzed } from "./NotAnalyzed";
import { RepoDiagram } from "./RepoDiagram";
import { RepoUnavailable } from "./RepoNotice";

/**
 * What `/<owner>/<repo>` and `/<owner>/<repo>/<sha>` render, from `viewRepo` (ADR-0068,
 * ADR-0069). Unconfigured or failing lookups say "temporarily unavailable"; a repo GitHub
 * doesn't show publicly, or a commit never analyzed, is a 404. A plain async function, not
 * a component, so tests can await and render it.
 */
export async function repoScreen(ref: RepoRef, sha?: string) {
  const deps = repoViewDepsFromEnv();
  if (deps === undefined) return <RepoUnavailable owner={ref.owner} repo={ref.repo} />;
  let view: Awaited<ReturnType<typeof viewRepo>>;
  try {
    view = await viewRepo(sha === undefined ? ref : { ...ref, sha }, deps);
  } catch (error) {
    // By name only: a database error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "repo_view_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return <RepoUnavailable owner={ref.owner} repo={ref.repo} />;
  }
  if (view.status === "missing") notFound();
  if (view.status === "not-analyzed") return <NotAnalyzed owner={view.owner} repo={view.repo} />;
  return (
    <RepoDiagram
      owner={view.owner}
      repo={view.repo}
      sha={view.sha}
      graphUrl={view.graphUrl}
      head={view.head}
    />
  );
}
