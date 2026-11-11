/**
 * The docs pages (M9.4a), in the order the docs nav and the site footer list them. They sit
 * at top-level paths (`/limits`, not `/docs/limits`) so none can shadow a repo page:
 * `/<owner>/<repo>` is GitHub's own path, and GitHub has an account named `docs`.
 */
export const DOCS_PAGES = [
  { href: "/how-it-works", title: "How it works" },
  { href: "/limits", title: "Limits" },
  { href: "/privacy", title: "Privacy" },
  { href: "/self-hosting", title: "Self-hosting" },
] as const;

/** One of {@link DOCS_PAGES}' paths. */
export type DocsHref = (typeof DOCS_PAGES)[number]["href"];

/** The repo on GitHub. */
export const REPO_HREF = "https://github.com/AbhinavGonthina/gitinside";

/** A file or folder of the repo on GitHub, on `main`. */
export function repoFile(path: string): string {
  return `${REPO_HREF}/blob/main/${path}`;
}
