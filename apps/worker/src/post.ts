import { PR_COMMENT_MARKER, type CheckRunText } from "@gitinside/diff";
import { JobFailure } from "./failure.js";

/**
 * Posting a pull request's diff to GitHub (M8.6e2, ADR-0245): the bot's one comment, edited in
 * place, and a completed Check Run on the head commit. Both calls carry the diff job's write
 * token (`access: "post"`, installationToken.ts), which the website mints only between the
 * job's diff and its Check Run. The text comes from `renderPrComment` / `renderCheckRun`.
 *
 * - **The comment** ({@link postComment}): the stored comment ID is edited
 *   (`PATCH /repos/{owner}/{repo}/issues/comments/{id}`); a `404` there (someone deleted it) or
 *   no stored ID looks for the bot's comment among the pull request's comments (oldest first,
 *   at most {@link MAX_COMMENT_PAGES} pages of 100): the first one written by a bot account
 *   (`user.type` `Bot`) whose body starts with {@link PR_COMMENT_MARKER}. A person's comment
 *   quoting the marker is never edited (people with write access may edit others' comments,
 *   and so may the bot's token). Found ⇒ edited; else created
 *   (`POST /repos/{owner}/{repo}/issues/{number}/comments`). The marker search keeps a job that
 *   posted but failed to record the ID from posting a second comment on retry.
 * - **The Check Run** ({@link createCheckRun}): created completed
 *   (`POST /repos/{owner}/{repo}/check-runs` with a `conclusion`, so GitHub sets the status and
 *   time). A retry after creating one but before recording it creates another on the same head;
 *   GitHub shows only the newest Check Run of a name per app, so the older one is hidden.
 *   Doesn't handle: deduplicating those (listing a commit's Check Runs can't tell ours from
 *   another app's of the same name without the App's ID, which the worker doesn't hold).
 * - **Redirects:** only `307`/`308` (a renamed repo, method kept) and, for reads, `301`/`302`
 *   are followed, inside the API's origin, at most {@link MAX_POST_REDIRECTS} hops; any other is
 *   refused, so the token never leaves the API host.
 * - **Failures** (job failures, failure.ts): a network error, `408`, or `5xx` ⇒ the retriable
 *   `POST_FAILED`; `403`/`429` with `x-ratelimit-remaining: 0` or `retry-after` (primary and
 *   secondary limits) ⇒ the retriable `GITHUB_RATE_LIMITED`; any other status (the pull request
 *   or repo gone, a locked conversation's `403`/`422`, writes not granted), a refused redirect,
 *   or a malformed answer ⇒ the permanent `POST_REFUSED`. When the signal fires, its reason is
 *   rethrown.
 *
 * Nothing from GitHub's answers is logged or kept but the IDs (positive safe integers).
 */

/** Where and how to post. */
export interface PostOptions {
  /** The diff job's write token. */
  token: string;
  /** GitHub's REST API. Default `https://api.github.com`. */
  apiBase?: string;
  /** Aborts every request. */
  signal?: AbortSignal;
  /** The fetch to use (tests). Default the global `fetch`. */
  fetch?: typeof fetch;
}

/** The pull request a post is for. Names are checked by `parseJobRequest` before a job runs. */
export interface PostTarget {
  owner: string;
  repo: string;
  number: number;
}

/** Pages of 100 comments searched for the bot's own before creating one. */
export const MAX_COMMENT_PAGES = 10;
/** Hops followed inside the API (a renamed repo is one). */
export const MAX_POST_REDIRECTS = 3;
/** A page of 100 comments of at most 65,536 characters each (4 bytes per character at worst). */
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
/** A created or edited comment or Check Run echoes its text back. */
const MAX_ANSWER_BYTES = 1024 * 1024;
const PAGE_SIZE = 100;
const USER_AGENT = "gitinside-worker";

type Method = "GET" | "POST" | "PATCH";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A positive safe integer ID from an answer, or `undefined`. */
function idOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const { id } = value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The job failure for a final status other than the expected one. */
function failureFor(status: number, headers: Headers, what: string): JobFailure {
  if (
    (status === 403 || status === 429) &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after"))
  ) {
    return new JobFailure(
      "GITHUB_RATE_LIMITED",
      `GitHub answered ${status} to ${what} (rate limit)`,
    );
  }
  if (status === 408 || status >= 500) {
    return new JobFailure("POST_FAILED", `GitHub answered ${status} to ${what}`);
  }
  return new JobFailure("POST_REFUSED", `GitHub answered ${status} to ${what}`);
}

/** At most `maxBytes` of the body as text, or `undefined` past that (the rest cancelled). */
async function readBounded(
  response: Response,
  maxBytes: number,
  what: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new JobFailure("POST_FAILED", `the answer to ${what} stopped`, { cause: error });
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One API request: `method {api}/<parts, each encoded>[?query]` with a JSON `body`. Answers the
 * final status and, for `expected` (or `404` when `allow404`), the parsed JSON (a body over
 * `maxBytes` or not JSON is `POST_REFUSED`). Other statuses throw through {@link failureFor}.
 */
async function request(
  method: Method,
  parts: readonly (string | number)[],
  options: PostOptions,
  call: {
    what: string;
    expected: number;
    body?: unknown;
    query?: string;
    maxBytes?: number;
    allow404?: boolean;
  },
): Promise<{ status: number; value: unknown }> {
  const doFetch = options.fetch ?? fetch;
  const api = new URL(options.apiBase ?? "https://api.github.com");
  const path = parts.map((part) => encodeURIComponent(String(part))).join("/");
  let url = new URL(`${api.pathname.replace(/\/$/, "")}/${path}`, api);
  if (call.query !== undefined) url.search = call.query;
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const follow = new Set(method === "GET" ? [301, 302, 307, 308] : [307, 308]);

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new JobFailure("POST_FAILED", `${call.what} to ${url.host} failed`, { cause: error });
    }
    const { status } = response;
    if (status === call.expected || (status === 404 && call.allow404 === true)) {
      if (status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { status, value: undefined };
      }
      const what = `the answer to ${call.what}`;
      const text = await readBounded(
        response,
        call.maxBytes ?? MAX_ANSWER_BYTES,
        what,
        options.signal,
      );
      try {
        if (text !== undefined) return { status, value: JSON.parse(text) as unknown };
      } catch {
        // Falls through to the refusal below.
      }
      throw new JobFailure("POST_REFUSED", `malformed ${what}`);
    }
    await response.body?.cancel().catch(() => undefined);
    if (!follow.has(status)) throw failureFor(status, response.headers, call.what);
    const location = response.headers.get("location");
    let next: URL | undefined;
    try {
      next = location === null ? undefined : new URL(location, url);
    } catch {
      next = undefined;
    }
    if (next?.origin !== api.origin || hop >= MAX_POST_REDIRECTS) {
      throw new JobFailure("POST_REFUSED", `redirect refused for ${call.what}`);
    }
    url = next;
  }
}

/** Edit comment `id` to `body`: its ID, or `undefined` when GitHub answers `404` (deleted). */
async function editComment(
  target: PostTarget,
  id: number,
  body: string,
  options: PostOptions,
): Promise<number | undefined> {
  const { status, value } = await request(
    "PATCH",
    ["repos", target.owner, target.repo, "issues", "comments", id],
    options,
    { what: "the comment edit", expected: 200, body: { body }, allow404: true },
  );
  if (status === 404) return undefined;
  if (idOf(value) !== id) throw new JobFailure("POST_REFUSED", "malformed comment edit answer");
  return id;
}

/** Whether a listed comment is the bot's own: written by a bot account, starting with the marker. */
function isBotComment(comment: unknown): boolean {
  if (!isRecord(comment) || !isRecord(comment.user)) return false;
  return (
    comment.user.type === "Bot" &&
    typeof comment.body === "string" &&
    comment.body.startsWith(PR_COMMENT_MARKER)
  );
}

/**
 * The ID of the pull request's first comment that {@link isBotComment} accepts, reading at most
 * {@link MAX_COMMENT_PAGES} pages, or `undefined` when there is none.
 */
async function findBotComment(
  target: PostTarget,
  options: PostOptions,
): Promise<number | undefined> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { value } = await request(
      "GET",
      ["repos", target.owner, target.repo, "issues", target.number, "comments"],
      options,
      {
        what: "the comment list",
        expected: 200,
        query: `per_page=${PAGE_SIZE}&page=${page}`,
        maxBytes: MAX_PAGE_BYTES,
      },
    );
    if (!Array.isArray(value)) throw new JobFailure("POST_REFUSED", "malformed comment list");
    const found = value.find(isBotComment);
    if (found !== undefined) {
      const id = idOf(found);
      if (id === undefined) throw new JobFailure("POST_REFUSED", "malformed comment list");
      return id;
    }
    if (value.length < PAGE_SIZE) return undefined;
  }
  return undefined;
}

/**
 * Post the bot's comment `body` on the pull request: edit `storedId` when given and it still
 * exists, else edit the bot's comment found by its marker, else create one (see the module
 * comment). Answers the comment's ID, to be recorded (`recordPullRequestComment`). `body` must
 * start with {@link PR_COMMENT_MARKER}, as `renderPrComment`'s does, or the next search can't
 * find it.
 */
export async function postComment(
  target: PostTarget,
  body: string,
  storedId: number | undefined,
  options: PostOptions,
): Promise<number> {
  if (!body.startsWith(PR_COMMENT_MARKER))
    throw new Error("the comment must start with its marker");
  if (storedId !== undefined) {
    const edited = await editComment(target, storedId, body, options);
    if (edited !== undefined) return edited;
  }
  const found = await findBotComment(target, options);
  if (found !== undefined && found !== storedId) {
    const edited = await editComment(target, found, body, options);
    if (edited !== undefined) return edited;
  }
  const { value } = await request(
    "POST",
    ["repos", target.owner, target.repo, "issues", target.number, "comments"],
    options,
    { what: "the new comment", expected: 201, body: { body } },
  );
  const id = idOf(value);
  if (id === undefined) throw new JobFailure("POST_REFUSED", "malformed new comment answer");
  return id;
}

/**
 * Create the Check Run `text` on commit `headSha`, completed (see the module comment). Answers
 * its ID, to be recorded (`recordPullRequestCheckRun`).
 */
export async function createCheckRun(
  target: Omit<PostTarget, "number">,
  headSha: string,
  text: CheckRunText,
  options: PostOptions,
): Promise<number> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("a Check Run needs the full head SHA");
  const { value } = await request(
    "POST",
    ["repos", target.owner, target.repo, "check-runs"],
    options,
    {
      what: "the new Check Run",
      expected: 201,
      body: {
        name: text.name,
        head_sha: headSha,
        status: "completed",
        conclusion: text.conclusion,
        output: { title: text.title, summary: text.summary },
      },
    },
  );
  const id = idOf(value);
  if (id === undefined) throw new JobFailure("POST_REFUSED", "malformed new Check Run answer");
  return id;
}
