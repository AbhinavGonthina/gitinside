import { Glyph, type GlyphName } from "@gitinside/viewer";
import Link from "next/link";
import type { SignInView } from "../lib/currentUser";
import { DEMO_GALLERY, type DemoCard } from "../lib/gallery";
import { RepoForm } from "./RepoForm";
import { SiteFooter } from "./SiteFooter";
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

/** Where the demo repos' hand checks are explained (`docs/demos/README.md`). */
export const DEMOS_DOC_HREF =
  "https://github.com/AbhinavGonthina/gitinside/blob/main/docs/demos/README.md";

/**
 * The demo gallery (M9.1b3, ADR-0259): each pin's own diagram image (one per theme, the page's
 * theme picks which shows), linking its permalink. Plain links, not `<Link>`: a prefetch would
 * render the permalink, which can queue the pin (ADR-0255), for every visitor who only scrolls
 * past. The images are decorative (the link's name is the repo's); `lazy` keeps the hidden
 * theme's from loading.
 */
function Gallery({ cards }: { cards: readonly DemoCard[] }) {
  return (
    <section className="landing__gallery" aria-labelledby="gallery-title">
      <h2 id="gallery-title" className="gallery__title">
        See it on real repos
      </h2>
      <p className="gallery__lede">
        Three open-source apps, each at one commit where every connection the analyzer worked out
        was checked by hand against the code. <a href={DEMOS_DOC_HREF}>How they were checked</a>
      </p>
      <ul className="gallery">
        {cards.map((card) => (
          <li key={card.href} className="demo">
            <a className="demo__link" href={card.href}>
              <span className="demo__thumb">
                {(["dark", "light"] as const).map((theme) => (
                  <img
                    key={theme}
                    className="demo__image"
                    data-theme-only={theme}
                    src={card.images[theme]}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ))}
              </span>
              <h3 className="demo__name">
                <span className="demo__owner">{card.owner}/</span>
                {card.name}
              </h3>
            </a>
            <p className="demo__about">{card.about}</p>
            <p className="demo__facts">
              <code>{card.shortSha}</code>
              <span aria-hidden> · </span>
              <span>
                {card.checked.toLocaleString("en-US")} checked, {card.wrong} wrong
              </span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The landing page's content (UX.md "Website flows"): the slogan, one field, the demo gallery,
 * and what you get, then the site footer (M9.4a). `note` is a failed sign-in's or sign-out's explanation; "Sign in for private repos"
 * (returning to the dashboard) shows while signed out, once sign-in is set up (M8.2b), and
 * "Your repos" once signed in (M8.2c).
 */
export function Landing({ signIn, note }: { signIn: SignInView; note?: string | undefined }) {
  return (
    <>
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
            code. Break it down from services to functions, and trace a request from page to
            database.
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
        <Gallery cards={DEMO_GALLERY} />
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
      <SiteFooter />
    </>
  );
}
