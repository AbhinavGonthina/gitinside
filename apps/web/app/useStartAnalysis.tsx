"use client";

import { useState, type ReactNode } from "react";
import { startAnalysis } from "../lib/startAnalysis";
import { BotCheck } from "./BotCheck";

/** Options for {@link useStartAnalysis}. */
export interface StartAnalysisOptions {
  /** Where the server said to go: the repo page, or the new job's progress page. */
  onStarted: (href: string) => void;
  /** After a refusal or a failed bot check, with what {@link StartAnalysis.error} now says. */
  onFailed?: (message: string) => void;
  /** Stay `pending` after a start, for a page that's navigating away (the landing form). */
  stayPending?: boolean;
}

/** What {@link useStartAnalysis} gives an Analyze button. */
export interface StartAnalysis {
  /** Ask for an analysis of `url`; ignored while a request is in flight. */
  start: (url: string) => Promise<void>;
  pending: boolean;
  /** The refusal to show, in the server's words, or the bot check's failure. */
  error: string | undefined;
  /** Show `message` as the error (e.g. a URL that didn't parse), ending any bot check. */
  fail: (message: string) => void;
  clearError: () => void;
  /** While the bot check runs: the server's reason, to say calmly (not as an error). */
  asked: string | undefined;
  /** The Turnstile widget to draw while the bot check runs, else `null`. */
  check: ReactNode;
}

/**
 * Every Analyze button's request to `/api/analyze` (the landing form, the repo page's Analyze
 * and Analyze again, the progress page's Try again). When the server asks for the bot check
 * (`CHALLENGE_REQUIRED`, ADR-0157), {@link StartAnalysis.check} is the widget and
 * {@link StartAnalysis.asked} the server's reason; once the widget passes, the same URL is sent
 * again with its token. Pressing the button again meanwhile drops the widget and asks afresh.
 */
export function useStartAnalysis({
  onStarted,
  onFailed,
  stayPending = false,
}: StartAnalysisOptions): StartAnalysis {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [challenge, setChallenge] = useState<{ siteKey: string; url: string; message: string }>();

  const fail = (message: string) => {
    setChallenge(undefined);
    setError(message);
    onFailed?.(message);
  };

  const run = async (url: string, token?: string) => {
    setError(undefined);
    setPending(true);
    const answer = await startAnalysis(url, fetch, token);
    if (answer.ok) {
      if (!stayPending) setPending(false);
      onStarted(answer.href);
      return;
    }
    setPending(false);
    if (answer.challenge) {
      setChallenge({ siteKey: answer.challenge.siteKey, url, message: answer.message });
      return;
    }
    fail(answer.message);
  };

  const start = async (url: string) => {
    // Not `disabled` while pending: a disabled button drops keyboard focus (CLAUDE.md lessons).
    if (pending) return;
    setChallenge(undefined);
    await run(url);
  };

  const check = challenge ? (
    <BotCheck
      siteKey={challenge.siteKey}
      onToken={(token) => {
        setChallenge(undefined);
        void run(challenge.url, token);
      }}
      onError={fail}
    />
  ) : null;

  return {
    start,
    pending,
    error,
    fail,
    clearError: () => setError(undefined),
    asked: challenge?.message,
    check,
  };
}
