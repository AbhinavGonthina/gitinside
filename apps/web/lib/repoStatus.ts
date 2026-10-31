import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";
import { permanentFailure } from "./jobs";
import type { HeadState } from "./repoView";
import { OFFLINE_MESSAGE, progressHref, repoHref } from "./startAnalysis";

/**
 * The browser's side of the diagram page (ADR-0069): what the line above the diagram says
 * about the default branch, and loading the graph from `/api/graph`. No server imports, so
 * the page's client components can use it.
 */

/** The first 7 characters of a SHA, as GitHub shows it. */
export function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The line above the diagram: how it relates to the latest commit, and what to do about it. */
export interface HeadStatus {
  /** `updating` marks a newer diagram on its way; the rest read as plain notes. */
  tone: "quiet" | "updating" | "behind";
  text: string;
  /** A page to go to: the progress page, or the latest diagram from a permalink. */
  link?: { href: string; label: string };
  /**
   * Offer "Analyze again" (the latest commit failed in a way another try could fix; it goes
   * through the visitor's limit).
   */
  analyze?: boolean;
}

function behindStatus(head: Extract<HeadState, { state: "behind" }>): HeadStatus {
  const latest = short(head.sha);
  switch (head.reason) {
    case "failed": {
      // A failure that would happen again gets its reason, not a button that can't help.
      const reason = permanentFailure(head.errorCode);
      if (reason !== undefined) {
        return {
          tone: "behind",
          text: `The latest commit, ${latest}, can't be analyzed, so this is an earlier one. ${reason}`,
        };
      }
      return {
        tone: "behind",
        text: `The latest commit, ${latest}, couldn't be analyzed, so this is an earlier one.`,
        analyze: true,
      };
    }
    case "limited":
      return {
        tone: "behind",
        text: `This repo changed often this hour, so the latest commit, ${latest}, will be analyzed on a later visit. This is an earlier one.`,
      };
    case "unavailable":
      return {
        tone: "behind",
        text: `Analysis is temporarily unavailable, so this is an earlier commit than the latest, ${latest}.`,
      };
  }
}

/** Words for a {@link HeadState} of `owner/repo` (UX.md "Copy rules": what happened, what to do). */
export function headStatus(owner: string, repo: string, head: HeadState): HeadStatus {
  switch (head.state) {
    case "pinned":
      return {
        tone: "quiet",
        text: "A permalink: this commit's diagram never changes.",
        link: { href: repoHref(owner, repo), label: "See the latest" },
      };
    case "current":
      return { tone: "quiet", text: "Up to date with the latest commit." };
    case "updating": {
      const text = `The latest commit, ${short(head.sha)}, is being analyzed. This is the previous diagram until it's ready.`;
      return head.jobId === undefined
        ? { tone: "updating", text }
        : {
            tone: "updating",
            text,
            link: { href: progressHref(owner, repo, head.jobId), label: "Watch progress" },
          };
    }
    case "behind":
      return behindStatus(head);
    case "unknown":
      return {
        tone: "behind",
        text: "We couldn't ask GitHub for newer commits, so this may not be the latest.",
      };
  }
}

/**
 * A loaded graph, or what to tell the visitor (a heading saying what happened, then why or
 * what to do) and whether trying again could help.
 */
export type GraphLoad =
  | { ok: true; graph: ArchitectureGraph }
  | { ok: false; title: string; message: string; retry: boolean };

export const LOAD_FAILED_TITLE = "The diagram didn't load";
export const LOAD_FAILED_MESSAGE =
  "Something went wrong between your browser and GitInside. Try again.";
export const UNREADABLE_TITLE = "The saved diagram couldn't be read";
export const UNREADABLE_MESSAGE =
  "It isn't in a shape this page can draw, so nothing is shown rather than part of it. The problem is on our side, not the repo's.";

/** The server's own message from an error body, if it sent one. */
async function serverMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const { message } = body;
      if (typeof message === "string" && message !== "") return message;
    }
  } catch {
    // not JSON: fall back to our own words
  }
  return undefined;
}

/**
 * Fetch and validate the graph at `url` (`/api/graph/…`). Never throws, except an abort.
 * A graph that doesn't match the schema is refused rather than drawn half right.
 */
export async function loadGraph(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GraphLoad> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, options.signal ? { signal: options.signal } : {});
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { ok: false, title: LOAD_FAILED_TITLE, message: OFFLINE_MESSAGE, retry: true };
  }
  if (!response.ok) {
    const message = await serverMessage(response);
    // 404: the snapshot is gone, so trying again can't help; anything else may pass.
    const retry = response.status !== 404;
    return { ok: false, title: LOAD_FAILED_TITLE, message: message ?? LOAD_FAILED_MESSAGE, retry };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The connection dropped mid-body: worth another try, unlike a bad graph.
    if (options.signal?.aborted) throw error;
    return { ok: false, title: LOAD_FAILED_TITLE, message: LOAD_FAILED_MESSAGE, retry: true };
  }
  try {
    return { ok: true, graph: parseGraph(JSON.parse(text)) };
  } catch {
    return { ok: false, title: UNREADABLE_TITLE, message: UNREADABLE_MESSAGE, retry: false };
  }
}
