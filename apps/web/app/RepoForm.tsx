"use client";

import { Button } from "@gitinside/viewer";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { SUPPORTED_SIZE } from "../lib/limits";
import { parseRepoUrl } from "../lib/repoUrl";
import { startAnalysis } from "../lib/startAnalysis";
import { BotCheck } from "./BotCheck";

/**
 * The landing page's one field: paste a GitHub repo URL, press Analyze.
 * The URL is checked here so a typo gets an answer before any request; a
 * valid one goes to `/api/analyze`, which checks it again on the server.
 * A cached commit opens the repo's page, a new one its progress page, and a
 * refusal (rate limit, missing repo, worker down) is said in place. When the
 * server asks for the bot check (ADR-0157), the Turnstile widget runs under
 * the field, and the same URL is sent again with its token once it passes.
 */
export function RepoForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState<{
    siteKey: string;
    url: string;
    message: string;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const fail = (message: string) => {
    setError(message);
    input.current?.focus();
  };

  const run = async (url: string, token?: string) => {
    setError(null);
    setPending(true);
    const answer = await startAnalysis(url, fetch, token);
    if (answer.ok) {
      router.push(answer.href);
      return;
    }
    setPending(false);
    if (answer.challenge) {
      setChallenge({ siteKey: answer.challenge.siteKey, url, message: answer.message });
      return;
    }
    setChallenge(null);
    fail(answer.message);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Not `disabled` while pending: a disabled button drops keyboard focus (CLAUDE.md lessons).
    if (pending) return;
    const result = parseRepoUrl(value);
    if (!result.ok) {
      setChallenge(null);
      fail(result.error);
      return;
    }
    await run(value);
  };

  return (
    <form className="repo-form" onSubmit={submit} noValidate aria-busy={pending || undefined}>
      <label htmlFor={`${id}-url`} className="visually-hidden">
        GitHub repo URL
      </label>
      <div className="repo-form__row" data-invalid={error ? "" : undefined}>
        <input
          ref={input}
          id={`${id}-url`}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Paste a GitHub repo URL"
          className="repo-form__input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
        />
        <Button type="submit" variant="primary" className="repo-form__submit">
          Analyze
        </Button>
      </div>
      <p
        id={`${id}-hint`}
        className="repo-form__hint"
        data-error={error ? "" : undefined}
        aria-live="polite"
      >
        {error ??
          (pending
            ? "Checking the latest commit on GitHub…"
            : (challenge?.message ??
              `Public repos, no sign-in. TypeScript and JavaScript (React, Next.js, Express, Prisma), ${SUPPORTED_SIZE}.`))}
      </p>
      {challenge && (
        <BotCheck
          siteKey={challenge.siteKey}
          onToken={(token) => {
            const { url } = challenge;
            setChallenge(null);
            void run(url, token);
          }}
          onError={(message) => {
            setChallenge(null);
            fail(message);
          }}
        />
      )}
    </form>
  );
}
