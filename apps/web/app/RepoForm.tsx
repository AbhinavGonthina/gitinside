"use client";

import { Button } from "@gitinside/viewer";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { SUPPORTED_SIZE } from "../lib/limits";
import { parseRepoUrl } from "../lib/repoUrl";
import { startAnalysis } from "../lib/startAnalysis";

/**
 * The landing page's one field: paste a GitHub repo URL, press Analyze.
 * The URL is checked here so a typo gets an answer before any request; a
 * valid one goes to `/api/analyze`, which checks it again on the server.
 * A cached commit opens the repo's page, a new one its progress page, and a
 * refusal (rate limit, missing repo, worker down) is said in place.
 */
export function RepoForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const fail = (message: string) => {
    setError(message);
    input.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Not `disabled` while pending: a disabled button drops keyboard focus (CLAUDE.md lessons).
    if (pending) return;
    const result = parseRepoUrl(value);
    if (!result.ok) {
      fail(result.error);
      return;
    }
    setError(null);
    setPending(true);
    const answer = await startAnalysis(value);
    if (answer.ok) {
      router.push(answer.href);
      return;
    }
    setPending(false);
    fail(answer.message);
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
            : `Public repos, no sign-in. TypeScript and JavaScript (React, Next.js, Express, Prisma), ${SUPPORTED_SIZE}.`)}
      </p>
    </form>
  );
}
