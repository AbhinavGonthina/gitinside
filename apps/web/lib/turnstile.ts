import { TURNSTILE_ORIGIN } from "./csp";

/**
 * Cloudflare Turnstile in the browser (the bot check on Analyze, ADR-0157): its script loaded
 * once, on demand, only when the server asks for the check. Nothing here runs on page load,
 * so a visitor who's never asked never fetches anything from Cloudflare.
 */

/** The widget's action; the server checks a token carries it (botCheck.ts). */
export const TURNSTILE_ACTION = "analyze";

/** Turnstile's explicit-render script (never self-hosted: Cloudflare updates it). */
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

/** The options this site passes to `turnstile.render` (Cloudflare's names). */
export interface TurnstileOptions {
  sitekey: string;
  action: string;
  theme: "light" | "dark";
  appearance: "interaction-only";
  callback: (token: string) => void;
  "error-callback": () => boolean;
  "timeout-callback": () => void;
}

/** The part of `window.turnstile` this site uses. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | null | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/**
 * Load Turnstile's script (once per page; a failed load can be tried again) and resolve with
 * its API. The script tag is added by our own nonced code, so the CSP's `'strict-dynamic'`
 * lets it run; its frame is allowed by `frame-src`.
 */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    const failed = () => {
      loading = undefined;
      script.remove();
      reject(new Error("Turnstile didn't load"));
    };
    script.addEventListener("load", () =>
      window.turnstile ? resolve(window.turnstile) : failed(),
    );
    script.addEventListener("error", failed);
    document.head.append(script);
  });
  return loading;
}
