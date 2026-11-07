import { Glyph, type GlyphName } from "@gitinside/viewer";
import Link from "next/link";
import type { SignInView } from "../lib/currentUser";
import { RepoForm } from "./RepoForm";
import { DASHBOARD_HREF, SIGN_IN_HREF } from "./SiteHeader";

/** What sets GitInside apart (SPEC §1), each with the glyph of what it's about. */
const PROMISES: readonly { glyph: GlyphName; title: string; text: string }[] = [
  {
    glyph: "file",
    title: "Parsed, never guessed",
    text: "Every box and arrow comes from the code and links to its source line. The same commit always gives the same diagram.",
  },
  {
    glyph: "service",
    title: "Services down to functions",
    text: "Break any service down in place: modules, files, then the functions inside.",
  },
  {
    glyph: "route",
    title: "Follow a request",
    text: "Trace a request from the page that sends it to the route, the database, and the APIs it calls.",
  },
  {
    glyph: "unresolved",
    title: "Gaps stay visible",
    text: "A call the analyzer can't pin down is drawn as unresolved, with the reason, instead of a guessed line.",
  },
];

/**
 * The landing page's content (UX.md "Website flows"): the slogan, one field, and what you
 * get. `note` is a failed sign-in's or sign-out's explanation; "Sign in for private repos"
 * (returning to the dashboard) shows while signed out, once sign-in is set up (M8.2b), and
 * "Your repos" once signed in (M8.2c).
 */
export function Landing({ signIn, note }: { signIn: SignInView; note?: string | undefined }) {
  return (
    <main className="landing">
      <section className="landing__hero" aria-labelledby="landing-title">
        {note !== undefined && (
          <p className="landing__note" role="status">
            {note}
          </p>
        )}
        <h1 id="landing-title" className="landing__title">
          Git inside your repo.
        </h1>
        <p className="landing__lede">
          Paste a GitHub repo and get an interactive system design diagram, built by parsing the
          code. Break it down from services to functions, and trace a request from page to database.
        </p>
        <RepoForm />
        {signIn.available && (
          <p className="landing__private">
            {signIn.login === undefined ? (
              <a href={`${SIGN_IN_HREF}?returnTo=${encodeURIComponent(DASHBOARD_HREF)}`}>
                Sign in for private repos
              </a>
            ) : (
              <Link href={DASHBOARD_HREF}>Your repos</Link>
            )}
          </p>
        )}
      </section>
      <ul className="landing__promises" aria-label="What you get">
        {PROMISES.map((p) => (
          <li key={p.title} className="promise">
            <span className="promise__icon" aria-hidden>
              <Glyph name={p.glyph} size={20} />
            </span>
            <h2 className="promise__title">{p.title}</h2>
            <p className="promise__text">{p.text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
