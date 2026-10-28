import type { Theme } from "@gitinside/viewer";
import { LogoMark } from "@gitinside/viewer";
import Link from "next/link";
import { ThemeSwitch } from "./ThemeSwitch";

/** The site's quiet top row: the mark and name (home), and the theme switch. */
export function SiteHeader({ theme }: { theme: Theme }) {
  return (
    <header className="site-header">
      <Link href="/" className="site-header__home">
        <LogoMark size={22} />
        <span>GitInside</span>
      </Link>
      <ThemeSwitch initial={theme} />
    </header>
  );
}
