/**
 * The browser's side of `POST /api/analyze` (ADR-0066, ADR-0067): send what was pasted and
 * say where to go next. A cached commit opens the repo's page; a queued one opens its
 * progress page; a refusal comes back as the server's own message, which is written for
 * visitors (UX.md "States").
 */

/** Where to go, or what to tell the visitor. */
export type StartResult = { ok: true; href: string } | { ok: false; message: string };

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

/** Ask the server to analyze `url` (a URL or `owner/repo`). Never throws. */
export async function startAnalysis(
  url: string,
  doFetch: typeof fetch = fetch,
): Promise<StartResult> {
  let response: Response;
  try {
    response = await doFetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
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
  const { status, owner, repo, jobId, message } = body;
  if (response.ok && text(owner) && text(repo)) {
    if (status === "done") return { ok: true, href: repoHref(owner, repo) };
    if (status === "queued" && text(jobId) && JOB_ID.test(jobId)) {
      return { ok: true, href: progressHref(owner, repo, jobId) };
    }
  }
  return { ok: false, message: !response.ok && text(message) ? message : FAILED_MESSAGE };
}
