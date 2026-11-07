import type { Theme } from "@gitinside/viewer";
import { Button, LinkButton, LogoMark } from "@gitinside/viewer";
import Link from "next/link";
import type { SignInView } from "../lib/currentUser";
import { ThemeSwitch } from "./ThemeSwitch";

/** Where "Sign in" starts (M8.2a's route; GitHub's authorize page follows). */
export const SIGN_IN_HREF = "/api/auth/github";
/** Where "Sign out" posts (same-origin only, ADR-0221). */
export const SIGN_OUT_ACTION = "/api/auth/signout";
/** The signed-in dashboard (M8.2c). */
export const DASHBOARD_HREF = "/dashboard";

/**
 * The site's quiet top row: the mark and name (home), then sign-in and the theme switch.
 * Signed out, a quiet "Sign in" link; signed in, the GitHub login (a link to the dashboard,
 * M8.2c) and "Sign out", a form
 * POST (a link can't sign out: a GET would let any page do it). Nothing about sign-in shows
 * while it isn't set up on the server.
 */
export function SiteHeader({ theme, signIn }: { theme: Theme; signIn: SignInView }) {
  return (
    <header className="site-header">
      <Link href="/" className="site-header__home">
        <LogoMark size={22} />
        <span>GitInside</span>
      </Link>
      <div className="site-header__end">
        {signIn.login !== undefined ? (
          <form method="post" action={SIGN_OUT_ACTION} className="site-header__account">
            <Link
              href={DASHBOARD_HREF}
              className="site-header__login"
              title={`Your repos (signed in with GitHub as ${signIn.login})`}
            >
              {signIn.login}
            </Link>
            <Button type="submit" variant="quiet">
              Sign out
            </Button>
          </form>
        ) : (
          signIn.available && (
            <LinkButton href={SIGN_IN_HREF} variant="quiet">
              Sign in
            </LinkButton>
          )
        )}
        <ThemeSwitch initial={theme} />
      </div>
    </header>
  );
}
