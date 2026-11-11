import Link from "next/link";
import type { ReactNode } from "react";
import { DOCS_PAGES, type DocsHref } from "../../lib/docs";
import { SiteFooter } from "../SiteFooter";

/**
 * A docs page's frame (M9.4a): the docs nav (the current page marked), the title and its
 * lede, the page's sections, then the site footer. This folder is private (`_docs`), so it
 * is no route.
 */
export function DocsPage({
  current,
  lede,
  children,
}: {
  current: DocsHref;
  lede: ReactNode;
  children: ReactNode;
}) {
  const title = DOCS_PAGES.find((page) => page.href === current)?.title;
  return (
    <>
      <main className="docs">
        <nav className="docs__nav" aria-label="Docs">
          <ul className="docs__tabs">
            {DOCS_PAGES.map((page) => (
              <li key={page.href}>
                <Link
                  href={page.href}
                  className="docs__tab"
                  aria-current={page.href === current ? "page" : undefined}
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="docs__article">
          <h1 className="docs__title">{title}</h1>
          <p className="docs__lede">{lede}</p>
          {children}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

/** A titled section of a docs page; `id` makes it linkable (`/limits#time`). */
export function DocsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="docs__section" aria-labelledby={id}>
      <h2 id={id} className="docs__heading">
        {title}
      </h2>
      {children}
    </section>
  );
}
