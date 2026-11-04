import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { BASE_PARAM, baseParam, type BaseView, type SearchParams } from "../../../lib/compare";
import type { RepoRef } from "../../../lib/repoUrl";
import { movedPath, viewBase, viewRepo } from "../../../lib/repoView";
import { repoViewDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../lib/serverDeps";
import { NotAnalyzed } from "./NotAnalyzed";
import { RepoDiagram } from "./RepoDiagram";
import { RepoUnavailable } from "./RepoNotice";

/**
 * What `/<owner>/<repo>` and `/<owner>/<repo>/<sha>` render, from `viewRepo` (ADR-0068,
 * ADR-0069). Unconfigured or failing lookups say "temporarily unavailable"; a repo GitHub
 * doesn't show publicly, or a commit never analyzed, is a 404. With `base` (a link's
 * `?base=`), the diagram compares with that commit (`viewBase`); a base that can't be
 * compared is a note on the page, not a 404. A repo GitHub knows under another name now
 * redirects there, the query (deep link, `?base=`) kept (M5.13b3). A plain async function,
 * not a component, so tests can await and render it.
 */
export async function repoScreen(ref: RepoRef, sha?: string, query: SearchParams = {}) {
  const base = baseParam(query[BASE_PARAM]);
  const oidcToken = (await headers()).get(VERCEL_OIDC_HEADER);
  const deps = repoViewDepsFromEnv(process.env, oidcToken);
  if (deps === undefined) return <RepoUnavailable owner={ref.owner} repo={ref.repo} />;
  let view: Awaited<ReturnType<typeof viewRepo>>;
  // Diff mode (M6.9e2): the commit the link compares with, once the shown one is known.
  let compared: BaseView | undefined;
  try {
    view = await viewRepo(sha === undefined ? ref : { ...ref, sha }, deps);
    if (view.status === "ready" && base !== undefined) {
      compared = await viewBase(view, base, deps.db);
    }
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
  // Outside the `try`: `redirect` throws Next's own error to do its work.
  if (view.status === "moved") redirect(movedPath(view, query));
  if (view.status === "not-analyzed") return <NotAnalyzed owner={view.owner} repo={view.repo} />;
  return (
    <RepoDiagram
      owner={view.owner}
      repo={view.repo}
      sha={view.sha}
      graphUrl={view.graphUrl}
      head={view.head}
      base={compared}
    />
  );
}
