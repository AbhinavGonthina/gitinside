/**
 * Technology logos (DESIGN_SYSTEM.md §3, "Icons"). Logos come from Simple Icons
 * (CC0; trademarks belong to their owners and identify the technology only)
 * and are looked up from the graph's own fields: `service.framework`,
 * `datastore.engine` / `queue.engine`, and `external.host`.
 *
 * Handled:
 * - Every framework the analyzer detects (`next`, `express`, `react`).
 * - The engines the analyzer emits (infra.ts, prisma.ts, queues.ts) that
 *   Simple Icons has a logo for.
 * - The hosts of the SDK allowlist (sdk.ts) that have a logo, plus common API
 *   hosts seen in `fetch` calls. A host matches its registrable suffix
 *   (`files.stripe.com` is Stripe), and the longest suffix wins
 *   (`maps.googleapis.com` is Google Maps, not Google).
 *
 * Not handled (these get the kind's glyph, never a guessed logo):
 * - Brands Simple Icons doesn't ship (removed at the owner's request or never
 *   added): OpenAI, AWS, Microsoft SQL Server, Twilio, Slack, SendGrid,
 *   Postmark, Memcached, Typesense, Redpanda.
 * - Hosts not in {@link HOST_BRANDS}, IP addresses, and loopback hosts.
 * - Anything inferred from a path or a package name rather than the node's
 *   own field (e.g. YouTube calls through `www.googleapis.com` show Google).
 */
import { compareStrings } from "@gitinside/schema";
import {
  siAlgolia,
  siAnthropic,
  siApachekafka,
  siAuth0,
  siBrevo,
  siClerk,
  siClickhouse,
  siCloudflare,
  siCockroachlabs,
  siContentful,
  siDiscord,
  siElasticsearch,
  siExpress,
  siFacebook,
  siFirebase,
  siGithub,
  siGitlab,
  siGoogle,
  siGooglegemini,
  siGooglemaps,
  siHubspot,
  siHuggingface,
  siLemonsqueezy,
  siLinear,
  siMailchimp,
  siMailgun,
  siMapbox,
  siMeilisearch,
  siMinio,
  siMistralai,
  siMongodb,
  siMysql,
  siNatsdotio,
  siNeon,
  siNextdotjs,
  siNotion,
  siOpensearch,
  siPaddle,
  siPaypal,
  siPostgresql,
  siRabbitmq,
  siReact,
  siRedis,
  siReplicate,
  siResend,
  siSanity,
  siSentry,
  siShopify,
  siSpotify,
  siSqlite,
  siStripe,
  siSupabase,
  siUpstash,
  siVercel,
  siX,
  siYoutube,
} from "simple-icons";
import { contrastRatio } from "../contrast.js";
import { themeTokens, type ThemeTokenName } from "../tokens.js";
import type { Theme } from "../ViewerRoot.js";

/** A technology logo: one filled path on Simple Icons' 24×24 grid. */
export interface Brand {
  /** The Simple Icons slug, e.g. `"postgresql"`. */
  slug: string;
  /** The brand's name, used as the accessible label. */
  title: string;
  /** The official brand color, lowercase `#rrggbb`. */
  hex: string;
  /** SVG path data on a 24×24 viewBox. */
  path: string;
}

interface SimpleIcon {
  slug: string;
  title: string;
  hex: string;
  path: string;
}

function brand(icon: SimpleIcon): Brand {
  return { slug: icon.slug, title: icon.title, hex: `#${icon.hex.toLowerCase()}`, path: icon.path };
}

/** `service.framework` values (workspace.ts `FRAMEWORKS`) → logo. */
const FRAMEWORK_BRANDS: ReadonlyMap<string, Brand> = new Map([
  ["express", brand(siExpress)],
  ["next", brand(siNextdotjs)],
  ["react", brand(siReact)],
]);

/** `datastore.engine` / `queue.engine` values → logo. Engines without a logo are listed above. */
const ENGINE_BRANDS: ReadonlyMap<string, Brand> = new Map([
  ["clickhouse", brand(siClickhouse)],
  ["cockroachdb", brand(siCockroachlabs)],
  ["elasticsearch", brand(siElasticsearch)],
  ["kafka", brand(siApachekafka)],
  ["meilisearch", brand(siMeilisearch)],
  ["minio", brand(siMinio)],
  ["mongo", brand(siMongodb)],
  ["mysql", brand(siMysql)],
  ["nats", brand(siNatsdotio)],
  ["opensearch", brand(siOpensearch)],
  ["postgres", brand(siPostgresql)],
  ["rabbitmq", brand(siRabbitmq)],
  ["redis", brand(siRedis)],
  ["sqlite", brand(siSqlite)],
]);

/** Registrable host suffixes → logo. A host matches itself and its subdomains. */
const HOST_BRANDS: ReadonlyMap<string, Brand> = new Map([
  ["algolia.net", brand(siAlgolia)],
  ["anthropic.com", brand(siAnthropic)],
  ["auth0.com", brand(siAuth0)],
  ["brevo.com", brand(siBrevo)],
  ["clerk.com", brand(siClerk)],
  ["cloudflare.com", brand(siCloudflare)],
  ["contentful.com", brand(siContentful)],
  ["discord.com", brand(siDiscord)],
  ["facebook.com", brand(siFacebook)],
  ["firebaseio.com", brand(siFirebase)],
  ["generativelanguage.googleapis.com", brand(siGooglegemini)],
  ["github.com", brand(siGithub)],
  ["githubusercontent.com", brand(siGithub)],
  ["gitlab.com", brand(siGitlab)],
  ["googleapis.com", brand(siGoogle)],
  ["hubapi.com", brand(siHubspot)],
  ["huggingface.co", brand(siHuggingface)],
  ["lemonsqueezy.com", brand(siLemonsqueezy)],
  ["linear.app", brand(siLinear)],
  ["mailchimp.com", brand(siMailchimp)],
  ["mailgun.net", brand(siMailgun)],
  ["mapbox.com", brand(siMapbox)],
  ["maps.googleapis.com", brand(siGooglemaps)],
  ["mistral.ai", brand(siMistralai)],
  ["myshopify.com", brand(siShopify)],
  ["neon.tech", brand(siNeon)],
  ["notion.com", brand(siNotion)],
  ["paddle.com", brand(siPaddle)],
  ["paypal.com", brand(siPaypal)],
  ["replicate.com", brand(siReplicate)],
  ["resend.com", brand(siResend)],
  ["sanity.io", brand(siSanity)],
  ["sentry.io", brand(siSentry)],
  ["spotify.com", brand(siSpotify)],
  ["stripe.com", brand(siStripe)],
  ["supabase.co", brand(siSupabase)],
  ["twitter.com", brand(siX)],
  ["upstash.io", brand(siUpstash)],
  ["vercel.com", brand(siVercel)],
  ["x.com", brand(siX)],
  ["youtube.com", brand(siYoutube)],
]);

/** The logo for a `service.framework` value, if it has one. */
export function brandForFramework(framework: string | undefined): Brand | undefined {
  return framework === undefined ? undefined : FRAMEWORK_BRANDS.get(framework);
}

/** The logo for a datastore or queue `engine`, if it has one. */
export function brandForEngine(engine: string): Brand | undefined {
  return ENGINE_BRANDS.get(engine);
}

/**
 * The logo for an external `host`, if it has one. The port and a trailing dot
 * are ignored and case doesn't matter; the longest matching suffix wins, and a
 * suffix only matches at a label boundary (`notstripe.com` is not Stripe).
 */
export function brandForHost(host: string): Brand | undefined {
  let name = host.toLowerCase().replace(/:\d+$/, "");
  if (name.endsWith(".")) name = name.slice(0, -1);
  for (;;) {
    const found = HOST_BRANDS.get(name);
    if (found) return found;
    const dot = name.indexOf(".");
    if (dot < 0) return undefined;
    name = name.slice(dot + 1);
  }
}

/** Every distinct logo in the tables, sorted by slug (for the gallery and tests). */
export const brands: readonly Brand[] = [
  ...new Map(
    [...FRAMEWORK_BRANDS.values(), ...ENGINE_BRANDS.values(), ...HOST_BRANDS.values()].map((b) => [
      b.slug,
      b,
    ]),
  ).values(),
].sort((a, b) => compareStrings(a.slug, b.slug));

/**
 * Surfaces a logo tile can have. The tile is always `surface-1` (node states
 * change the node around it, never the tile), so a brand color only has to
 * clear 3:1 there. Checking a darker hover fill too turned Redis, GitLab, and
 * Spotify monochrome in light for no visible gain.
 */
export const TILE_SURFACES: readonly ThemeTokenName[] = ["surface-1"];

/** The monochrome fallback: primary text, which clears 4.5:1 on every surface. */
export const MONOCHROME = "var(--text)";

/**
 * The fill for a logo in a theme: its official color when that is at least
 * 3:1 (WCAG 1.4.11, graphics) on every {@link TILE_SURFACES} color, otherwise
 * {@link MONOCHROME}. Next.js's black mark is black on light tiles and
 * text-colored on dark ones.
 */
export function brandFill(b: Brand, theme: Theme): string {
  const passes = TILE_SURFACES.every((s) => contrastRatio(b.hex, themeTokens[theme][s]) >= 3);
  return passes ? b.hex : MONOCHROME;
}
