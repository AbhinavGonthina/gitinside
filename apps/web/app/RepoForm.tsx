"use client";

import { Button } from "@gitinside/viewer";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { parseRepoUrl } from "../lib/repoUrl";

/**
 * The landing page's one field: paste a GitHub repo URL, press Analyze.
 * The URL is checked here so a typo gets an answer before any request; a
 * valid one opens the repo's page. (From M5.6 it starts an analysis through
 * `/api/analyze` instead, which checks it again on the server.)
 */
export function RepoForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = parseRepoUrl(value);
    if (!result.ok) {
      setError(result.error);
      input.current?.focus();
      return;
    }
    setError(null);
    router.push(`/${encodeURIComponent(result.owner)}/${encodeURIComponent(result.repo)}`);
  };

  return (
    <form className="repo-form" onSubmit={submit} noValidate>
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
          "Public repos, no sign-in. TypeScript and JavaScript: React, Next.js, Express, Prisma."}
      </p>
    </form>
  );
}
