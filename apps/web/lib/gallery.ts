import { DEMO_PINS, type DemoPin } from "@gitinside/db";

/**
 * The landing page's demo gallery (UX.md "Website flows", SPEC M9, ADR-0259): one card per demo
 * pin (`DEMO_PINS`, in its order), linking the pin's permalink, with the pin's own diagram image
 * as its thumbnail. The counts are the hand checks' (`docs/demos/<owner>__<name>.json`'s
 * `totals`, which a test reads), so the card says exactly what was checked.
 */

/** What a card says about one pin, beyond its name and commit. */
interface DemoCopy {
  /** One sentence on what the app is, from its own GitHub description. */
  about: string;
  /** Inferred edges at the pin, every one checked by hand (the record's `totals.edges`). */
  checked: number;
  /** How many of them were wrong (the record's `totals.wrong`: the bar is 0, D13.4). */
  wrong: number;
}

/** Keyed by `owner/name` as the pin spells it. */
const COPY: Readonly<Record<string, DemoCopy>> = {
  "Mintplex-Labs/anything-llm": {
    about: "A local-first AI app: chat with your documents and run agents on the model you choose.",
    checked: 873,
    wrong: 0,
  },
  "shadcn-ui/taxonomy": {
    about: "An example app built on Next.js 13's app router and server components.",
    checked: 29,
    wrong: 0,
  },
  "getmaxun/maxun": {
    about: "Turns any website into a structured API: extract, automate, and monitor the web.",
    checked: 142,
    wrong: 0,
  },
};

/** One gallery card. */
export interface DemoCard extends DemoCopy {
  owner: string;
  name: string;
  /** The pin's commit, 7 characters, as the diagram's footer shows it. */
  shortSha: string;
  /** The pin's permalink, `/<owner>/<name>/<sha>`. */
  href: string;
  /** The pin's diagram image in each theme (`/api/diagram/<owner>/<name>/<sha>.svg`). */
  images: { dark: string; light: string };
}

/** The card for `pin`; throws for a pin without copy, which a test rules out. */
export function demoCard(pin: DemoPin): DemoCard {
  const { owner, name, sha } = pin;
  const copy = COPY[`${owner}/${name}`];
  if (copy === undefined) throw new Error(`no gallery copy for ${owner}/${name}`);
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${sha}`;
  const image = (theme: "dark" | "light") => `/api/diagram/${path}.svg?theme=${theme}`;
  return {
    ...copy,
    owner,
    name,
    shortSha: sha.slice(0, 7),
    href: `/${path}`,
    images: { dark: image("dark"), light: image("light") },
  };
}

/** The gallery's cards, one per demo pin, in the pins' order. */
export const DEMO_GALLERY: readonly DemoCard[] = DEMO_PINS.map(demoCard);
