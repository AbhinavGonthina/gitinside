import { DEMO_PINS } from "@gitinside/db";

/**
 * The M10 design prototype (M10.3, `app/prototype`): the redesign Abhinav reviews at the design
 * gate, drawn over five real stored graphs. It lives on a page nothing links to, until he approves
 * it (PROGRESS.md "Iteration 2": no UI ships into the real explorer or site before the gate).
 *
 * The graphs are production's, read through `app/api/prototype/graph` (a fixed host and a fixed
 * list, so the route can't be pointed anywhere else), so a preview deployment shows the same
 * diagrams whether or not it has a database.
 */

/** One repo the prototype draws, at a fixed commit. */
export interface PrototypeRepo {
  owner: string;
  name: string;
  /** The commit whose stored graph is drawn: 40 lowercase hex characters. */
  sha: string;
}

/** Where the graphs are read: production, whose `/api/graph` serves every public analysis. */
export const PROTOTYPE_GRAPH_ORIGIN = "https://gitinside.abhinavgonthina.dev";

/**
 * The five repos of M10.1's "before" screenshots, in that order: wanderlust and documenso at the
 * commits those shots drew (the latest analyzed on 2026-11-13), then the three hand-checked demo
 * pins at their pinned commits.
 */
export const PROTOTYPE_REPOS: readonly PrototypeRepo[] = [
  {
    owner: "krishnaacharyaa",
    name: "wanderlust",
    sha: "2d83720e4318a7f999d3f9d751013b105f0c805a",
  },
  { owner: "documenso", name: "documenso", sha: "1e2333d534e151578ffb05394428e2a7efea5f50" },
  ...DEMO_PINS.map(({ owner, name, sha }) => ({ owner, name, sha })),
];

/**
 * The prototype's repo named `owner/name` (as `?repo=` spells it, any case), or undefined for
 * anything else: only these five are drawn or proxied.
 */
export function findPrototypeRepo(
  owner: string | undefined,
  name: string | undefined,
): PrototypeRepo | undefined {
  if (owner === undefined || name === undefined) return undefined;
  const key = `${owner}/${name}`.toLowerCase();
  return PROTOTYPE_REPOS.find((r) => `${r.owner}/${r.name}`.toLowerCase() === key);
}

/** `findPrototypeRepo` for a `?repo=owner/name` value. */
export function prototypeRepoParam(
  value: string | string[] | undefined,
): PrototypeRepo | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  return parts.length === 2 ? findPrototypeRepo(parts[0], parts[1]) : undefined;
}

/** The prototype page of a repo: `/prototype?repo=<owner>/<name>`. */
export function prototypeHref(repo: PrototypeRepo): string {
  return `/prototype?repo=${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Where the page reads a repo's graph: this site's proxy of production's. */
export function prototypeGraphUrl(repo: PrototypeRepo): string {
  return `/api/prototype/graph/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** The production graph the proxy reads for a repo. */
export function upstreamGraphUrl(repo: PrototypeRepo): string {
  return `${PROTOTYPE_GRAPH_ORIGIN}/api/graph/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${repo.sha}`;
}
