/**
 * The browser's side of `POST /api/analyze` (ADR-0066, ADR-0067): send what was pasted and
 * say where to go next. A cached commit opens the repo's page; a queued one opens its
 * progress page; a refusal comes back as the server's own message, which is written for
 * visitors (UX.md "States").
 */

/**
 * Where to go, or what to tell the visitor. `challenge` comes with a refusal that needs the
 * bot check (ADR-0157): the Turnstile widget's site key, to show it and send its token back.
 */
export type StartResult =
  | { ok: true; href: string }
  | { ok: false; message: string; challenge?: { siteKey: string } };

export const OFFLINE_MESSAGE = "We couldn't reach GitInside. Check your connection and try again.";
export const FAILED_MESSAGE = "Something went wrong on our side. Try again.";

const JOB_ID = /^analyze-[0-9a-f]{32}$/;

/** The repo page's path; owner and repo are GitHub's spelling from the server. */
export function repoHref(owner: string, repo: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The progress page's path for a job. */
export function progressHref(owner: string, repo: string, jobId: string): string {
  return `${repoHref(owner, repo)}/jobs/${jobId}`;
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Ask the server to analyze `url` (a URL or `owner/repo`), with the bot check's token when the
 * visitor was asked for it. Never throws.
 */
export async function startAnalysis(
  url: string,
  doFetch: typeof fetch = fetch,
  turnstileToken?: string,
): Promise<StartResult> {
  let response: Response;
  try {
    response = await doFetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnstileToken === undefined ? { url } : { url, turnstileToken }),
    });
  } catch {
    return { ok: false, message: OFFLINE_MESSAGE };
  }
  let body: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null) throw new TypeError("not an object");
    body = value as Record<string, unknown>;
  } catch {
    return { ok: false, message: FAILED_MESSAGE };
  }
  const { status, owner, repo, jobId, message, error, siteKey } = body;
  if (response.ok && text(owner) && text(repo)) {
    if (status === "done") return { ok: true, href: repoHref(owner, repo) };
    if (status === "queued" && text(jobId) && JOB_ID.test(jobId)) {
      return { ok: true, href: progressHref(owner, repo, jobId) };
    }
  }
  // Only a check asked for shows the widget; a failed one says to press Analyze again.
  if (response.status === 403 && error === "CHALLENGE_REQUIRED" && text(siteKey) && text(message)) {
    return { ok: false, message, challenge: { siteKey } };
  }
  return { ok: false, message: !response.ok && text(message) ? message : FAILED_MESSAGE };
}
