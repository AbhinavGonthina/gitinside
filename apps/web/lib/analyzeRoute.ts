import {
  requestAnalysis,
  UNAVAILABLE_MESSAGE,
  type AnalyzeDeps,
  type AnalyzeResponse,
} from "./analyze";
import { clientAddress } from "./clientIp";

/**
 * The HTTP edge of `POST /api/analyze` (ADR-0066), apart from Next.js so tests call it with a
 * plain `Request`:
 *
 * - **JSON only** (`content-type: application/json`). A cross-site page can't send that
 *   without a CORS preflight, which we never answer, so other sites can't spend a visitor's
 *   rate limit (no CSRF token needed).
 * - **Bodies over {@link MAX_BODY_BYTES} are refused** unread or as soon as they pass it.
 * - The body is `{ "url": "<what was pasted>" }` and nothing else.
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

/** Read at most `max` bytes of the body; `undefined` if it's longer. */
async function readBody(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return undefined;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Answer one `POST /api/analyze`. `deps` is `undefined` when the server isn't configured
 * (no database or worker yet): every request then gets UX.md's "temporarily unavailable".
 */
export async function handleAnalyzeRequest(
  request: Request,
  deps: AnalyzeDeps | undefined,
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
    Object.keys(value).some((k) => k !== "url") ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    return json(400, { error: "INVALID_REQUEST", message: 'Send JSON: { "url": "…" }.' });
  }
  if (value.url.length > MAX_URL_LENGTH) {
    return json(400, {
      error: "INVALID_URL",
      message: "That isn't a GitHub repo URL. Try https://github.com/owner/repo.",
    });
  }
  if (deps === undefined) return json(503, { error: "UNAVAILABLE", message: UNAVAILABLE_MESSAGE });

  try {
    const answer = await requestAnalysis(value.url, clientAddress(request.headers), deps);
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
