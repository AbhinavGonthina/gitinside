import type { IncomingMessage, ServerResponse } from "node:http";

/** HTTP helpers shared by the worker's endpoints (api.ts, run.ts). */

/**
 * Unauthenticated liveness: `200` while the process serves requests (the worker's `POST /run`
 * server and the kill switch's).
 */
export const HEALTH_PATH = "/health";

/** A job body is a few hundred bytes; anything far past that is refused unread. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Answer with a JSON body, never cached or sniffed. */
export function send(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

/** Read the body up to `max` bytes; `undefined` if it's larger (the rest is drained unread). */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Whether a `content-type` header is JSON. */
export function isJson(req: IncomingMessage): boolean {
  return /^application\/json\s*(?:;|$)/i.test(req.headers["content-type"] ?? "");
}
