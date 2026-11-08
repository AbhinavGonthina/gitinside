import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { AnyDatabase } from "@gitinside/db";
import { BASE_PARAM, baseParam, type BaseView, type SearchParams } from "../../../lib/compare";
import type { RepoRef } from "../../../lib/repoUrl";
import { movedPath, viewBase, viewRepo, type RepoView } from "../../../lib/repoView";
import { authDepsFromEnv, repoViewDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../lib/serverDeps";
import { NotAnalyzed } from "./NotAnalyzed";
import { RepoDiagram } from "./RepoDiagram";
import { RepoUnavailable } from "./RepoNotice";

/** What {@link loadView} found: the view, or that it couldn't be had. */
type Loaded = { view: RepoView; db: AnyDatabase } | { unavailable: true };

/** Log a failed lookup by name only: a database error's message can carry connection details. */
function logFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      event: "repo_view_failed",
      error: error instanceof Error ? error.name : "unknown",
    }),
  );
}

/**
 * The view of `/<owner>/<repo>[/<sha>]` (`viewRepo`). With sign-in configured, the request's
 * cookie is the viewer, for private repos (M8.4c1). Only the page itself calls it, never
 * `generateMetadata`: Next resolves a page's metadata when a `<Link>` to it is prefetched, so a
 * view there would run check-on-view (GitHub calls, enqueues, `hideRepo`) for every repo link
 * merely shown on screen. It did, and a permalink's "See the latest" hid the seeded E2E repo.
 */
async function loadView(owner: string, repo: string, sha: string | undefined): Promise<Loaded> {
  const request = await headers();
  const deps = repoViewDepsFromEnv(process.env, request.get(VERCEL_OIDC_HEADER));
  if (deps === undefined) return { unavailable: true };
  const auth = authDepsFromEnv();
  const viewed =
    auth === undefined ? deps : { ...deps, viewer: { cookie: request.get("cookie"), auth } };
  try {
    return {
      view: await viewRepo(sha === undefined ? { owner, repo } : { owner, repo, sha }, viewed),
      db: deps.db,
    };
  } catch (error) {
    logFailure(error);
    return { unavailable: true };
  }
}

/**
 * The page's metadata: the tab's title, from the path alone (no lookup, see {@link loadView}).
 * A private repo's `noindex` is rendered by {@link repoScreen} with the diagram instead.
 */
export function repoMetadata(ref: RepoRef, sha?: string): Metadata {
  return {
    title:
      sha === undefined
        ? `${ref.owner}/${ref.repo}`
        : `${ref.owner}/${ref.repo} at ${sha.slice(0, 7)}`,
  };
}

/**
 * What `/<owner>/<repo>` and `/<owner>/<repo>/<sha>` render, from `viewRepo` (ADR-0068,
 * ADR-0069). Unconfigured or failing lookups say "temporarily unavailable", and so does a
 * private repo's access check that can't decide (M8.4c1); a repo GitHub doesn't show publicly
 * (and the viewer can't see privately), or a commit never analyzed, is a 404. With `base` (a
 * link's `?base=`), the diagram compares with that commit (`viewBase`); a base that can't be
 * compared is a note on the page, not a 404. A repo GitHub knows under another name now
 * redirects there, the query (deep link, `?base=`) kept (M5.13b3). A plain async function,
 * not a component, so tests can await and render it.
 */
export async function repoScreen(ref: RepoRef, sha?: string, query: SearchParams = {}) {
  const base = baseParam(query[BASE_PARAM]);
  const loaded = await loadView(ref.owner, ref.repo, sha);
  if ("unavailable" in loaded) return <RepoUnavailable owner={ref.owner} repo={ref.repo} />;
  const { view } = loaded;
  // Diff mode (M6.9e2): the commit the link compares with, once the shown one is known.
  let compared: BaseView | undefined;
  if (view.status === "ready" && base !== undefined) {
    try {
      compared = await viewBase(view, base, loaded.db);
    } catch (error) {
      logFailure(error);
      return <RepoUnavailable owner={ref.owner} repo={ref.repo} />;
    }
  }
  if (view.status === "missing") notFound();
  // Outside the `try`: `redirect` throws Next's own error to do its work.
  if (view.status === "moved") redirect(movedPath(view, query));
  if (view.status === "not-analyzed") return <NotAnalyzed owner={view.owner} repo={view.repo} />;
  return (
    <>
      {/* SPEC §3: private results are never indexed. React hoists it into <head>; only a shown
          private page has it, so a refused one carries exactly a missing repo's head. */}
      {view.private && <meta name="robots" content="noindex, nofollow" />}
      <RepoDiagram
        owner={view.owner}
        repo={view.repo}
        sha={view.sha}
        graphUrl={view.graphUrl}
        head={view.head}
        base={compared}
        isPrivate={view.private !== undefined}
      />
    </>
  );
}
