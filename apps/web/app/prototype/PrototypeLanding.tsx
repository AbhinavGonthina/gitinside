import { LinkButton } from "@gitinside/viewer";
import Link from "next/link";
import type { SignInView } from "../../lib/currentUser";
import { DEMO_GALLERY } from "../../lib/gallery";
import {
  HERO_REPO,
  PROTOTYPE_GRAPH_ORIGIN,
  PROTOTYPE_REPOS,
  prototypeHref,
  prototypeTourHref,
  TOUR_REPO,
} from "../../lib/prototype";
import { RepoForm } from "../RepoForm";
import { SiteFooter } from "../SiteFooter";
import { DASHBOARD_HREF, SIGN_IN_HREF } from "../SiteHeader";
import { HostSwap } from "./HostSwap";
import { HowItWorks, PrototypeGallery } from "./PrototypeGallery";
import { PrototypeHero } from "./PrototypeHero";

/**
 * The prototype's landing page (M10-design §3.5, B13, B14; M10.3e1, M10.3e2a): the shipped
 * landing with a first screen that shows the product working. Beside the slogan and the field,
 * the live explorer on the hero pin plays its suggested trace; "See how it works" opens the
 * tour's pin with its guided tour started (M10.3f2a); under them, the URL swap line. Then the gallery
 * as readable crops of each pin, "How it works" in three columns, and the five repos under
 * review, for Abhinav's click-through. Links to prototype pages are plain `<a>`s, never `Link`:
 * cross-document View Transitions (transitions.css, M10.3e2b) run on document navigations only.
 */
export function PrototypeLanding({ signIn }: { signIn: SignInView }) {
  const host = new URL(PROTOTYPE_GRAPH_ORIGIN).host;
  return (
    <>
      <main className="landing" data-prototype="">
        <section className="landing__hero" aria-labelledby="landing-title">
          <div className="landing__pitch">
            <h1 id="landing-title" className="landing__title">
              Git inside your repo.
            </h1>
            <p className="landing__lede">
              Paste a GitHub repo and get an interactive system design diagram, built by parsing the
              code.
            </p>
            <RepoForm />
            <p className="landing__actions">
              <LinkButton href={prototypeTourHref(TOUR_REPO)} icon="play">
                See how it works
              </LinkButton>
              {signIn.available &&
                (signIn.login === undefined ? (
                  <a href={`${SIGN_IN_HREF}?returnTo=${encodeURIComponent(DASHBOARD_HREF)}`}>
                    Sign in for private repos
                  </a>
                ) : (
                  <Link href={DASHBOARD_HREF}>Your repos</Link>
                ))}
            </p>
          </div>
          <PrototypeHero repo={HERO_REPO} />
        </section>
        <HostSwap
          path={`/${HERO_REPO.owner}/${HERO_REPO.name}`}
          host={host}
          href={prototypeHref(HERO_REPO)}
        />
        <PrototypeGallery cards={DEMO_GALLERY} />
        <HowItWorks />
        <section className="landing__review" aria-labelledby="review-title">
          <h2 id="review-title" className="gallery__title">
            Design review: the five repos
          </h2>
          <p className="gallery__lede">
            The M10 redesign, drawn over real stored graphs before any of it ships.
          </p>
          <ul className="notice__links">
            {PROTOTYPE_REPOS.map((r) => (
              <li key={`${r.owner}/${r.name}`}>
                {/* A document navigation, as every link between prototype pages, so the
                    page transition runs (transitions.css). */}
                <a href={prototypeHref(r)}>
                  {r.owner} / {r.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
