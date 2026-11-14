import { Glyph, type GlyphName } from "@gitinside/viewer";
import type { DemoCard } from "../../lib/gallery";
import { findPrototypeRepo, prototypeHref } from "../../lib/prototype";
import { GALLERY_CROP, prototypeImageUrl } from "../../lib/prototypeImage";
import { DEMOS_DOC_HREF } from "../Landing";

/**
 * The prototype landing's gallery (M10-design §3.5, M10.3e2a): the shipped cards' words, but each
 * thumbnail is a crop of the pin's README image at 100% around its hub
 * (`/api/prototype/diagram`), so its names read, and each card opens the pin's prototype page.
 * Hovering pans the crop 4px each way (globals.css); the frame never lifts or grows a shadow.
 * Plain links, as on the shipped gallery: no prefetch for visitors who only scroll past.
 */
export function PrototypeGallery({ cards }: { cards: readonly DemoCard[] }) {
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
        {cards.map((card) => {
          const repo = findPrototypeRepo(card.owner, card.name);
          if (repo === undefined) throw new Error(`${card.owner}/${card.name} isn't drawn`);
          return (
            <li key={card.href} className="demo">
              <a className="demo__link" href={prototypeHref(repo)}>
                <span className="demo__thumb" data-crop="">
                  {(["dark", "light"] as const).map((theme) => (
                    <img
                      key={theme}
                      className="demo__image"
                      data-theme-only={theme}
                      src={prototypeImageUrl(repo, theme)}
                      width={GALLERY_CROP.width}
                      height={GALLERY_CROP.height}
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
          );
        })}
      </ul>
    </section>
  );
}

/** How a diagram is made (M10-design §3.5: parse → link → draw), each with its glyph. */
const STEPS: readonly { glyph: GlyphName; title: string; text: string }[] = [
  {
    glyph: "file",
    title: "Parse",
    text: "Reads the code at one commit with the TypeScript compiler: workspaces, pages, routes, Prisma models, and docker-compose services. Nothing in the repo is run or installed.",
  },
  {
    glyph: "route",
    title: "Link",
    text: "Matches each fetch and axios call to the route that answers it, and each Prisma call to its model. A call it can't pin down stays on the diagram, with the reason.",
  },
  {
    glyph: "service",
    title: "Draw",
    text: "Lays it out from services down to functions. Break any box down in place, or trace a request from the page that sends it to the database.",
  },
];

/** The landing's "How it works": {@link STEPS} as three short columns, in order. */
export function HowItWorks() {
  return (
    <section id="how-it-works" className="landing__how" aria-labelledby="how-title">
      <h2 id="how-title" className="gallery__title">
        How it works
      </h2>
      <ol className="steps">
        {STEPS.map((step) => (
          <li key={step.title} className="promise">
            <span className="promise__icon" aria-hidden>
              <Glyph name={step.glyph} size={20} />
            </span>
            <h3 className="promise__title">{step.title}</h3>
            <p className="promise__text">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
