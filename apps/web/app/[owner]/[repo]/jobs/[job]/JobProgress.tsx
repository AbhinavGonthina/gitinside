"use client";

import { Button } from "@gitinside/viewer";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PROGRESS_STEPS, UNAVAILABLE_VIEW, type JobView } from "../../../../../lib/jobs";
import { repoHref, startAnalysis } from "../../../../../lib/startAnalysis";

/** Props for {@link JobProgress}. */
export interface JobProgressProps {
  /** GitHub's spelling, checked by the page. */
  owner: string;
  repo: string;
  /** An `analyze-…` job ID, checked by the page. */
  jobId: string;
}

/** A view still moving: the steps list is drawn for it. */
type LiveView = Extract<JobView, { state: "queued" | "running" }>;

const STATES = new Set(["queued", "running", "done", "failed", "missing", "unavailable"]);

/** One `status` event's view, or `undefined` if it isn't one (same origin, but checked anyway). */
function parseView(data: unknown): JobView | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== "object" || value === null || !("state" in value)) return undefined;
    return typeof value.state === "string" && STATES.has(value.state)
      ? (value as JobView)
      : undefined;
  } catch {
    return undefined;
  }
}

const CHECK = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path
      d="M3.5 8.5 6.5 11.5 12.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The live part of the progress page: listens to `/api/jobs/:id/events`, lists the real
 * stages with the worker's own words ("Parsing 1,204 files") and the queue position ("2
 * ahead of you"), and opens the diagram when it's saved. A failure replaces the list with
 * what happened and what to do; if the worker is unreachable the last known progress stays
 * on screen with UX.md's notice while the browser keeps reconnecting.
 */
export function JobProgress({ owner, repo, jobId }: JobProgressProps) {
  const router = useRouter();
  const [live, setLive] = useState<LiveView | undefined>(undefined);
  const [ended, setEnded] = useState<Extract<JobView, { state: "failed" | "missing" }>>();
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [retryError, setRetryError] = useState<string | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  // Bumped by "Try again" when the new job has the same ID, so the stream restarts.
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const home = repoHref(owner, repo);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${jobId}/events`);
    source.addEventListener("status", (event) => {
      const view = parseView((event as MessageEvent).data);
      if (view === undefined) return;
      if (view.state === "unavailable") {
        setNotice(view.message);
        return;
      }
      setNotice(undefined);
      if (view.state === "queued" || view.state === "running") {
        setLive(view);
      } else {
        source.close();
        if (view.state === "done") router.replace(home);
        else setEnded(view);
      }
    });
    source.addEventListener("error", () => {
      // CONNECTING: the browser retries by itself. CLOSED: it gave up (the server refused).
      if (source.readyState === EventSource.CLOSED) setNotice(UNAVAILABLE_VIEW.message);
    });
    return () => source.close();
  }, [jobId, attempt, home, router]);

  useEffect(() => {
    if (ended) heading.current?.focus();
  }, [ended]);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(undefined);
    const answer = await startAnalysis(`${owner}/${repo}`);
    setRetrying(false);
    if (!answer.ok) {
      setRetryError(answer.message);
      return;
    }
    if (answer.href === window.location.pathname) {
      setEnded(undefined);
      setLive(undefined);
      setAttempt((n) => n + 1);
    } else {
      router.push(answer.href);
    }
  };

  const github = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const title = (
    <>
      <span className="notice__owner">{owner} /</span> {repo}
    </>
  );

  if (ended) {
    const canRetry = ended.state === "missing" || ended.retry;
    return (
      <main className="notice progress">
        <h1 className="notice__title" ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="progress__failure" role="alert">
          {ended.message}
        </p>
        {retryError && (
          <p className="progress__failure" role="alert">
            {retryError}
          </p>
        )}
        <div className="progress__actions">
          {canRetry && (
            <Button variant="primary" onClick={retry} aria-busy={retrying || undefined}>
              {ended.state === "missing" ? "Analyze again" : "Try again"}
            </Button>
          )}
          <p className="notice__links">
            <Link href="/">Analyze another repo</Link>
            <a href={github} rel="noopener noreferrer">
              Open on GitHub
            </a>
          </p>
        </div>
      </main>
    );
  }

  const current = live?.step ?? "queue";
  const currentIndex = PROGRESS_STEPS.findIndex((s) => s.step === current);
  const detail = live?.text ?? "Checking the queue";
  const progress = live?.progress ?? 0;
  const currentLabel = PROGRESS_STEPS[currentIndex]?.label ?? "";

  return (
    <main className="notice progress">
      <h1 className="notice__title">{title}</h1>
      <p className="notice__text">
        Reading the code to build its diagram. This page opens it when it&apos;s ready.
      </p>
      <div
        className="progress__bar"
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={`${currentLabel}: ${detail}`}
      >
        <span className="progress__fill" style={{ width: `${progress}%` }} />
      </div>
      <ol className="progress__steps">
        {PROGRESS_STEPS.map(({ step, label }, index) => {
          const status =
            index < currentIndex ? "done" : index === currentIndex ? "current" : "next";
          return (
            <li
              key={step}
              className="progress__step"
              data-status={status}
              aria-current={status === "current" ? "step" : undefined}
            >
              <span className="progress__marker" aria-hidden="true">
                {status === "done" ? CHECK : null}
              </span>
              <span className="progress__label">
                {label}
                {status === "done" && <span className="visually-hidden"> (done)</span>}
              </span>
              {status === "current" && <span className="progress__detail">{detail}</span>}
            </li>
          );
        })}
      </ol>
      <p className="visually-hidden" role="status">
        {detail}
      </p>
      {notice && (
        <p className="progress__notice" role="alert">
          {notice}
        </p>
      )}
      <p className="notice__links">
        <a href={github} rel="noopener noreferrer">
          Open on GitHub
        </a>
      </p>
    </main>
  );
}
