import {
  requestAnalysis,
  UNAVAILABLE_MESSAGE,
  type AnalyzeDeps,
  type AnalyzeResponse,
  type Caller,
} from "./analyze";
import { readSession, type AuthDeps } from "./authRoute";
import { readBody } from "./body";
import { CHALLENGE_FAILED_MESSAGE, MAX_TOKEN_LENGTH } from "./botCheck";
import { clientAddress } from "./clientIp";
import { resolvePrivateRepo } from "./privateRepo";

/**
 * The HTTP edge of `POST /api/analyze` (ADR-0066), apart from Next.js so tests call it with a
 * plain `Request`:
 *
 * - **JSON only** (`content-type: application/json`). A cross-site page can't send that
 *   without a CORS preflight, which we never answer, so other sites can't spend a visitor's
 *   rate limit (no CSRF token needed).
 * - **Bodies over {@link MAX_BODY_BYTES} are refused** unread or as soon as they pass it.
 * - The body is `{ "url": "<what was pasted>" }`, plus `"turnstileToken"` once the visitor
 *   was asked for the bot check (botCheck.ts), and nothing else. A token that's empty, not a
 *   string, or longer than Cloudflare's tokens is refused as a failed check.
 * - **Who counts:** a request carrying a live session cookie counts against its user's
 *   hourly limit, any other against its address (`readSession`, M8.2b). The JSON-only rule
 *   above also keeps another site from spending a signed-in visitor's limit.
 * - **Private repos** (M8.4c2b): a signed-in caller's name the public lookup doesn't find is
 *   asked again with their own GitHub token (`resolvePrivateRepo`).
 * - **Never cached** (`cache-control: no-store`). Unexpected errors are `500 INTERNAL` with a
 *   generic message; the error itself is logged by name only.
 */

/** `{ "url": … }` with a pasted URL is well under 1 KiB. */
export const MAX_BODY_BYTES = 4 * 1024;
/** Longest pasted text looked at (a deep GitHub link is a few hundred characters). */
export const MAX_URL_LENGTH = 2_048;

type Body = AnalyzeResponse["body"] | { error: string; message: string };

function json(status: number, body: Body, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * Answer one `POST /api/analyze`. `deps` is `undefined` when the server isn't configured
 * (no database or worker yet): every request then gets UX.md's "temporarily unavailable".
 */
export async function handleAnalyzeRequest(
  request: Request,
  deps: AnalyzeDeps | undefined,
  /** Sign-in's deps: a request with a live session counts against its user (M8.2b). */
  auth?: AuthDeps,
): Promise<Response> {
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json(415, { error: "UNSUPPORTED_MEDIA_TYPE", message: 'Send JSON: { "url": "…" }.' });
  }
  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (bytes === undefined) {
    return json(413, { error: "BODY_TOO_LARGE", message: "That request is too large." });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json(400, { error: "INVALID_JSON", message: 'Send JSON: { "url": "…" }.' });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => k !== "url" && k !== "turnstileToken") ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    return json(400, { error: "INVALID_REQUEST", message: 'Send JSON: { "url": "…" }.' });
  }
  let token: string | undefined;
  if ("turnstileToken" in value) {
    const { turnstileToken } = value;
    if (
      typeof turnstileToken !== "string" ||
      turnstileToken === "" ||
      turnstileToken.length > MAX_TOKEN_LENGTH
    ) {
      return json(403, { error: "CHALLENGE_FAILED", message: CHALLENGE_FAILED_MESSAGE });
    }
    token = turnstileToken;
  }
  if (value.url.length > MAX_URL_LENGTH) {
    return json(400, {
      error: "INVALID_URL",
      message: "That isn't a GitHub repo URL. Try https://github.com/owner/repo.",
    });
  }
  if (deps === undefined) return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });

  try {
    const user = await readSession(request.headers.get("cookie"), auth);
    const caller: Caller =
      user && auth
        ? {
            userId: user.userId,
            privateRepos: (ref) => resolvePrivateRepo(ref, user, auth, deps.github),
          }
        : clientAddress(request.headers);
    const answer = await requestAnalysis(value.url, caller, deps, token);
    return json(answer.status, answer.body, answer.headers);
  } catch (error) {
    // Name only: a driver error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "analyze_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json(500, {
      error: "INTERNAL",
      message: "Something went wrong on our side. Try again.",
    });
  }
}
