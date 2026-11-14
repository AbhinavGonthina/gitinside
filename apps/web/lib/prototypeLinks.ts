/**
 * The M10 prototype's links (M10.3, `lib/prototype.ts`), apart from its repo list so client
 * components can use them: the list reads `@gitinside/db`'s demo pins, which a browser bundle
 * can't take (it brings the Postgres driver).
 */

/** One repo the prototype draws, at a fixed commit. */
export interface PrototypeRepo {
  owner: string;
  name: string;
  /** The commit whose stored graph is drawn: 40 lowercase hex characters. */
  sha: string;
}

/** The prototype's landing page (M10.3e1), where its bar's mark goes. */
export const PROTOTYPE_HOME = "/prototype";

/**
 * The prototype page of a repo: `/prototype?repo=<owner>/<name>`, then an explorer state's query
 * (`encodeState`, with or without its `?`) if one is given.
 */
export function prototypeHref(repo: PrototypeRepo, state = ""): string {
  const page = `${PROTOTYPE_HOME}?repo=${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const rest = state.replace(/^\?/, "");
  return rest === "" ? page : `${page}&${rest}`;
}

/** The query parameter that starts the guided tour on a prototype page (M10.3f2a). */
export const TOUR_PARAM = "tour";

/** A repo's prototype page with its guided tour started (M10-design §3.1): `…&tour`. */
export function prototypeTourHref(repo: PrototypeRepo): string {
  return `${prototypeHref(repo)}&${TOUR_PARAM}`;
}

/** The prototype's API map page (M10-design §3.3, M10.3f3). */
export const PROTOTYPE_API = `${PROTOTYPE_HOME}/api`;

/**
 * A repo's API map page: `/prototype/api?repo=<owner>/<name>`, then the page's own query
 * (`apiQueryString`) if one is given.
 */
export function prototypeApiHref(repo: PrototypeRepo, query = ""): string {
  const page = `${PROTOTYPE_API}?repo=${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  return query === "" ? page : `${page}&${query}`;
}

/** Where the page reads a repo's graph: this site's proxy of production's. */
export function prototypeGraphUrl(repo: PrototypeRepo): string {
  return `/api/prototype/graph/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
