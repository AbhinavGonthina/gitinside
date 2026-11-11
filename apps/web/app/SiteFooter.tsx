import Link from "next/link";
import { DOCS_PAGES, REPO_HREF } from "../lib/docs";

/**
 * The quiet bottom row of the landing and docs pages (M9.4a): the docs, then the code on
 * GitHub. Never on a repo's diagram page, where the canvas fills the window.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="About GitInside">
        <ul className="site-footer__links">
          {DOCS_PAGES.map((page) => (
            <li key={page.href}>
              <Link href={page.href}>{page.title}</Link>
            </li>
          ))}
          <li>
            <a href={REPO_HREF}>Source on GitHub</a>
          </li>
        </ul>
      </nav>
    </footer>
  );
}
