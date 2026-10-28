/**
 * The site's Content-Security-Policy (SECURITY.md T10: "strict CSP on
 * apps/web"). Diagrams render repo-controlled text (file names, labels, code),
 * so even if an escaping bug ever let markup through, the browser must refuse
 * to run any script the server didn't mark with this response's nonce.
 */

/** Options for {@link buildCsp}. */
export interface CspOptions {
  /** A fresh, unguessable nonce for this response (see {@link createNonce}). */
  nonce: string;
  /** `next dev`: React needs `eval` for its dev-only error overlays, and dev styles carry no nonce. */
  dev: boolean;
  /** The request came over HTTPS, so any stray `http:` subresource is upgraded. */
  https: boolean;
}

/**
 * Builds the policy for one response:
 * - **Scripts:** only those carrying the nonce (Next.js adds it to its own
 *   scripts when it finds it in this header), plus what they load
 *   (`'strict-dynamic'`). No inline handlers, no `eval` outside dev.
 * - **Styles:** our stylesheets and nonced `<style>` tags; `style` attributes
 *   are allowed (`style-src-attr`) because the viewer positions nodes and
 *   passes theme fills through inline custom properties, and attributes
 *   can't run code.
 * - **Everything else is our origin only:** fonts are self-hosted (ADR-0047),
 *   no plugins, no `<base>` rewriting, forms post only to us, and no other
 *   site may frame us.
 */
export function buildCsp({ nonce, dev, https }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** 16 random bytes, base64: a fresh nonce for every response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Headers sent with every response, pages and API alike (next.config.ts).
 * The CSP itself comes from proxy.ts, because it needs a per-response nonce.
 */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
