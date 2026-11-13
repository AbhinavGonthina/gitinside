import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  PROTOTYPE_REPOS,
  prototypeGraphUrl,
  prototypeHref,
  prototypeRepoParam,
} from "../../lib/prototype";
import { PrototypeDiagram } from "./PrototypeDiagram";

/** Never indexed: the page is for the design gate's review only. */
export const metadata: Metadata = {
  title: "Design prototype",
  robots: { index: false, follow: false },
};

/**
 * The M10 design prototype (M10.3, lib/prototype.ts): with no `repo`, a list of the five repos it
 * draws; with `?repo=<owner>/<name>` of one of them, that repo's diagram in the redesign. Any other
 * `repo` is a 404. One path segment, so it never shadows a GitHub owner's repo pages
 * (`/<owner>/<repo>`), and nothing on the site links here.
 */
export default async function PrototypePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (await searchParams) ?? {};
  if (query.repo === undefined) {
    return (
      <main className="notice">
        <h1 className="notice__title">Design prototype</h1>
        <p className="notice__text">
          The M10 redesign, drawn over real stored graphs for review before any of it ships. Pick a
          repo:
        </p>
        <ul className="notice__links">
          {PROTOTYPE_REPOS.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <Link href={prototypeHref(r)}>
                {r.owner} / {r.name}
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  const repo = prototypeRepoParam(query.repo);
  if (repo === undefined) notFound();
  return (
    <PrototypeDiagram
      owner={repo.owner}
      repo={repo.name}
      sha={repo.sha}
      graphUrl={prototypeGraphUrl(repo)}
    />
  );
}
