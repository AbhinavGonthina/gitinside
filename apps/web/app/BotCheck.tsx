"use client";

import { useEffect, useRef } from "react";
import { parseTheme } from "../lib/theme";
import { loadTurnstile, TURNSTILE_ACTION, type TurnstileApi } from "../lib/turnstile";

export const LOAD_FAILED_MESSAGE =
  "The check that you're a person couldn't load. Make sure challenges.cloudflare.com isn't blocked, then press Analyze again.";
export const CHECK_FAILED_MESSAGE =
  "The check that you're a person didn't pass. Press Analyze to try again.";
export const CHECK_TIMED_OUT_MESSAGE =
  "The check that you're a person timed out. Press Analyze to try again.";

/**
 * Cloudflare Turnstile's widget for the bot check on Analyze (ADR-0157), shown only when the
 * server asked for it. Managed mode with `interaction-only`: most visitors pass without seeing
 * anything; a checkbox appears here only when Cloudflare wants one. In the site's theme.
 * `onToken` gets the token to send back; `onError` a message for the visitor.
 */
export function BotCheck({
  siteKey,
  onToken,
  onError,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onError: (message: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The latest callbacks, so a re-render doesn't re-create the widget.
  const handlers = useRef({ onToken, onError });
  useEffect(() => {
    handlers.current = { onToken, onError };
  });

  useEffect(() => {
    let live = true;
    let widget: { api: TurnstileApi; id: string } | undefined;
    loadTurnstile().then(
      (api) => {
        const container = box.current;
        if (!live || !container) return;
        const id = api.render(container, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          theme: parseTheme(document.documentElement.dataset.theme),
          appearance: "interaction-only",
          callback: (token) => handlers.current.onToken(token),
          "error-callback": () => {
            handlers.current.onError(CHECK_FAILED_MESSAGE);
            return true; // handled: said in the form
          },
          "timeout-callback": () => handlers.current.onError(CHECK_TIMED_OUT_MESSAGE),
        });
        if (id) widget = { api, id };
        else handlers.current.onError(LOAD_FAILED_MESSAGE);
      },
      () => {
        if (live) handlers.current.onError(LOAD_FAILED_MESSAGE);
      },
    );
    return () => {
      live = false;
      if (widget) widget.api.remove(widget.id);
    };
  }, [siteKey]);

  return <div ref={box} className="bot-check" data-testid="bot-check" />;
}
