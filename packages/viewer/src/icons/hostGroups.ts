/**
 * What outside hosts are for (M10.3b1, M10-design A6), so the prototype's system level can draw
 * anything-llm's 50 outside APIs as a few boxes ("AI models · 27") instead of a column taller than
 * the canvas. A fixed table in the repo, matched like `brands.ts` matches logos: a host belongs to
 * a group when it is one of the group's registrable suffixes or under one, at a label boundary
 * (`api.openai.com` is an AI model, `notopenai.com` isn't), and the longest suffix wins
 * (`maps.googleapis.com` is Maps, `sheets.googleapis.com` productivity). The same graph always
 * groups the same way, and the host itself stays exact on every line: a group says what a host is
 * for, never which host a call reached.
 *
 * Handled: the hosts in the five prototype repos' stored graphs (2026-11-13) and the common
 * services of each kind. Not handled: anything not listed is "Other hosts" (never a guess from
 * the name: `api.keenable.ai` isn't called an AI model for its `.ai`), and a provider's generic API
 * host that serves many products (`www.googleapis.com`, `azure.com`) stays "Other hosts" too.
 *
 * Bump {@link HOST_GROUPS_VERSION} whenever the table changes (its test pins the table's digest).
 */

/** The table's version; bumped with every change to {@link HOST_GROUPS}. */
export const HOST_GROUPS_VERSION = 1;

/** One purpose outside hosts are grouped by. */
export interface HostGroup {
  /** Stable, URL-safe ID part: `group:hosts/<slug>`. */
  slug: string;
  /** The group's name on the canvas, sentence case: "AI models". */
  title: string;
}

/** A group and the registrable host suffixes in it. */
interface HostGroupEntry extends HostGroup {
  suffixes: readonly string[];
}

/** Hosts not in any group. */
export const OTHER_HOSTS: HostGroup = { slug: "other", title: "Other hosts" };

/** The groups, in the order the design lists them, each with its suffixes sorted. */
export const HOST_GROUPS: readonly HostGroupEntry[] = [
  {
    slug: "ai",
    title: "AI models",
    suffixes: [
      "ai.azure.com",
      "ai.gitee.com",
      "aiplatform.googleapis.com",
      "anthropic.com",
      "apipie.ai",
      "assemblyai.com",
      "cerebras.ai",
      "cohere.ai",
      "cohere.com",
      "cometapi.com",
      "deepgram.com",
      "deepinfra.com",
      "deepseek.com",
      "elevenlabs.io",
      "fireworks.ai",
      "generativelanguage.googleapis.com",
      "groq.com",
      "huggingface.co",
      "minimax.io",
      "minimaxi.com",
      "mistral.ai",
      "models.dev",
      "moonshot.ai",
      "moonshot.cn",
      "novita.ai",
      "openai.azure.com",
      "openai.com",
      "openrouter.ai",
      "perplexity.ai",
      "ppinfra.com",
      "qianfan.baidubce.com",
      "replicate.com",
      "sambanova.ai",
      "together.ai",
      "together.xyz",
      "voyageai.com",
      "x.ai",
      "z.ai",
    ],
  },
  {
    slug: "payments",
    title: "Payments",
    suffixes: [
      "adyen.com",
      "braintreegateway.com",
      "lemonsqueezy.com",
      "paddle.com",
      "paypal.com",
      "polar.sh",
      "razorpay.com",
      "squareup.com",
      "stripe.com",
    ],
  },
  {
    slug: "email",
    title: "Email",
    suffixes: [
      "brevo.com",
      "email.amazonaws.com",
      "loops.so",
      "mailchimp.com",
      "mailgun.net",
      "mailjet.com",
      "mandrillapp.com",
      "postmarkapp.com",
      "resend.com",
      "sendgrid.com",
      "sendgrid.net",
      "sendinblue.com",
      "sparkpost.com",
    ],
  },
  {
    slug: "auth",
    title: "Auth",
    suffixes: [
      "accounts.google.com",
      "auth0.com",
      "challenges.cloudflare.com",
      "clerk.com",
      "clerk.dev",
      "hcaptcha.com",
      "login.microsoftonline.com",
      "oauth2.googleapis.com",
      "okta.com",
      "recaptcha.net",
      "stytch.com",
      "workos.com",
    ],
  },
  {
    slug: "storage",
    title: "Storage and files",
    suffixes: [
      "backblazeb2.com",
      "blob.core.windows.net",
      "cloudinary.com",
      "dropboxapi.com",
      "r2.cloudflarestorage.com",
      "s3.amazonaws.com",
      "storage.googleapis.com",
      "uploadthing.com",
    ],
  },
  {
    slug: "code",
    title: "Code hosting",
    suffixes: ["bitbucket.org", "github.com", "githubusercontent.com", "gitlab.com"],
  },
  {
    slug: "search",
    title: "Search and scraping",
    suffixes: [
      "algolia.io",
      "algolia.net",
      "anysearch.com",
      "bing.microsoft.com",
      "duckduckgo.com",
      "exa.ai",
      "fastcrw.com",
      "firecrawl.dev",
      "meilisearch.com",
      "search.brave.com",
      "searchapi.io",
      "serpapi.com",
      "serper.dev",
      "serply.io",
      "tavily.com",
      "typesense.net",
      "ydc-index.io",
      "you.com",
    ],
  },
  {
    slug: "maps",
    title: "Maps",
    suffixes: ["mapbox.com", "mapquestapi.com", "maps.googleapis.com", "openstreetmap.org"],
  },
  {
    slug: "analytics",
    title: "Analytics and monitoring",
    suffixes: [
      "amplitude.com",
      "datadoghq.com",
      "google-analytics.com",
      "mixpanel.com",
      "plausible.io",
      "posthog.com",
      "segment.com",
      "segment.io",
      "sentry.io",
    ],
  },
  {
    slug: "productivity",
    title: "Productivity and docs",
    suffixes: [
      "airtable.com",
      "atlassian.net",
      "docs.googleapis.com",
      "graph.microsoft.com",
      "hubapi.com",
      "linear.app",
      "notion.com",
      "notion.so",
      "script.google.com",
      "sheets.googleapis.com",
      "slack.com",
      "trello.com",
    ],
  },
];

const BY_SUFFIX: ReadonlyMap<string, HostGroup> = new Map(
  HOST_GROUPS.flatMap(({ slug, title, suffixes }) =>
    suffixes.map((s): [string, HostGroup] => [s, { slug, title }]),
  ),
);

/**
 * The group an outside `host` belongs to, else {@link OTHER_HOSTS}. The port and a trailing dot
 * are ignored and case doesn't matter; the longest matching suffix wins (`brandForHost`'s rule).
 */
export function hostGroupFor(host: string): HostGroup {
  let name = host.toLowerCase().replace(/:\d+$/, "");
  if (name.endsWith(".")) name = name.slice(0, -1);
  for (;;) {
    const found = BY_SUFFIX.get(name);
    if (found) return found;
    const dot = name.indexOf(".");
    if (dot < 0) return OTHER_HOSTS;
    name = name.slice(dot + 1);
  }
}
