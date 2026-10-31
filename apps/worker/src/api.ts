import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from "./hmac.js";
import type { FoundFacts } from "./progress.js";

/**
 * The enqueue API: the only port the worker VM exposes, behind Caddy TLS (docs/DESIGN.md §11,
 * docs/SECURITY.md T8; ADR-0060). The web app calls it; Redis never leaves the Docker network.
 *
 * - `GET /health`, unauthenticated: `200 {"status":"ok"}` when the queue answers within
 *   {@link HEALTH_TIMEOUT_MS}, else `503 {"status":"unavailable"}`. Nothing else is said.
 * - `POST /enqueue` `{ kind, owner, repo, sha, baseSha?, installationId? }`: `202 { id, created }`.
 *   The ID is derived from the request (and the analyzer version), so the same repo@sha is one
 *   job; `created: false` means it was already queued, running, or kept.
 * - `GET /jobs/:id`: `200` with the job's state, or `404 JOB_NOT_FOUND`.
 *
 * Every route but `/health` needs a valid signature (hmac.ts), checked on the raw body before
 * anything is parsed and before routing, so an unsigned caller learns nothing, not even which
 * paths exist. Errors are `{ "error": "<CODE>" }` (plus a fixed `message` for a bad body).
 * The queue itself is an interface, backed by BullMQ in queue.ts.
 */

/** What a job does: analyze one commit, or diff two (M6/M8). */
export type JobKind = "analyze" | "diff";

/** A validated `POST /enqueue` body. */
export interface JobRequest {
  kind: JobKind;
  owner: string;
  repo: string;
  /** The commit to analyze (for `diff`, the head). 40 lowercase hex. */
  sha: string;
  /** Required for `diff`, refused for `analyze`. */
  baseSha?: string;
  /** Set for private repos (GitHub App installation, M8). */
  installationId?: number;
}

/** Where a job is. Mirrors `analyses.status` (DESIGN.md §10). */
export type JobState = "queued" | "running" | "done" | "failed";

/** What `GET /jobs/:id` returns. Only these fields are ever serialized. */
export interface JobStatus {
  id: string;
  kind: JobKind;
  state: JobState;
  /** The pipeline stage while running (`download`, `extract`, `analyze`, `upload`). */
  stage?: string;
  /** 0–100 while running. */
  progress?: number;
  /** In `analyze`: the analyzer stage running (`programs`, `http`, …; progress.ts). */
  step?: string;
  /** With `step`, when known: source files being parsed (`programs`), requests being linked (`http`). */
  count?: number;
  /** While running, once the analyzer has found something: what it found so far (#8). */
  found?: FoundFacts;
  /** Jobs ahead of this one while queued (0 = next). */
  position?: number;
  /** Set when `failed`: `LIMIT_TIME`, `TAR_INVALID`, … */
  errorCode?: string;
}

/** The queue behind the API. */
export interface JobQueue {
  /** Add a job under `id` unless one with that ID exists; `created` says which. */
  add(id: string, request: JobRequest): Promise<{ created: boolean }>;
  get(id: string): Promise<JobStatus | undefined>;
  /** Resolves when the queue's backing store answers. */
  ping(): Promise<void>;
}

/** Options for {@link createEnqueueHandler}. */
export interface EnqueueApiOptions {
  queue: JobQueue;
  /** Accepted signing secrets: the current one first, the previous one during a rollover. */
  secrets: readonly string[];
  /** Part of every job ID, so a new analyzer re-analyzes a commit instead of reusing the job. */
  analyzerVersion: string;
  /** Clock in milliseconds (tests fix it). Default `Date.now`. */
  now?: () => number;
  /** Largest accepted body. Default {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
}

/** A job body is a few hundred bytes; anything far past that is refused unread. */
export const MAX_BODY_BYTES = 16 * 1024;
/** How long `/health` waits for the queue. */
export const HEALTH_TIMEOUT_MS = 2_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const JOB_ID = /^(?:analyze|diff)-[0-9a-f]{32}$/;
const JOB_PATH = /^\/jobs\/([^/]+)$/;
const KEYS = new Set(["kind", "owner", "repo", "sha", "baseSha", "installationId"]);

/** Thrown by {@link parseJobRequest}; the message names a field, never echoes its value. */
export class JobRequestError extends Error {
  override name = "JobRequestError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed `POST /enqueue` body. Owner and repo follow GitHub's name rules (the
 * same as apps/web's URL parser); SHAs are full lowercase hex; unknown keys are refused.
 */
export function parseJobRequest(value: unknown): JobRequest {
  if (!isRecord(value)) throw new JobRequestError("body must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new JobRequestError(`unknown field ${JSON.stringify(key)}`);
  }
  const { kind, owner, repo, sha, baseSha, installationId } = value;
  if (kind !== "analyze" && kind !== "diff") {
    throw new JobRequestError('kind must be "analyze" or "diff"');
  }
  if (typeof owner !== "string" || !OWNER.test(owner)) {
    throw new JobRequestError("owner is not a GitHub owner name");
  }
  if (typeof repo !== "string" || !REPO.test(repo) || repo === "." || repo === "..") {
    throw new JobRequestError("repo is not a GitHub repo name");
  }
  if (typeof sha !== "string" || !SHA.test(sha)) {
    throw new JobRequestError("sha must be 40 lowercase hex characters");
  }
  if (kind === "diff") {
    if (typeof baseSha !== "string" || !SHA.test(baseSha)) {
      throw new JobRequestError("baseSha must be 40 lowercase hex characters");
    }
  } else if (baseSha !== undefined) {
    throw new JobRequestError("baseSha is only for diff jobs");
  }
  if (
    installationId !== undefined &&
    (typeof installationId !== "number" ||
      !Number.isSafeInteger(installationId) ||
      installationId < 1)
  ) {
    throw new JobRequestError("installationId must be a positive integer");
  }
  return {
    kind,
    owner,
    repo,
    sha,
    ...(kind === "diff" ? { baseSha: baseSha as string } : {}),
    ...(installationId === undefined ? {} : { installationId }),
  };
}

/**
 * The job ID for a request: `<kind>-<32 hex>`, a SHA-256 over the kind, the lowercased owner
 * and repo (GitHub names ignore case), the SHAs, and the analyzer version. The same commit is
 * therefore one job however often it's asked for (the dedupe in T9), and the ID can't be
 * guessed without knowing the repo. `installationId` isn't part of it: it changes who may
 * fetch the commit, not what the analysis is.
 */
export function jobIdFor(request: JobRequest, analyzerVersion: string): string {
  const key = JSON.stringify([
    request.kind,
    request.owner.toLowerCase(),
    request.repo.toLowerCase(),
    request.sha,
    request.baseSha ?? null,
    analyzerVersion,
  ]);
  return `${request.kind}-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function send(
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

/** Copy only the documented fields, so nothing the queue stores internally reaches a caller. */
function publicStatus(status: JobStatus): JobStatus {
  const { id, kind, state, stage, progress, step, count, position, errorCode } = status;
  return {
    id,
    kind,
    state,
    ...(stage === undefined ? {} : { stage }),
    ...(progress === undefined ? {} : { progress }),
    ...(step === undefined ? {} : { step }),
    ...(count === undefined ? {} : { count }),
    ...(position === undefined ? {} : { position }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** Read the body up to `max` bytes; `undefined` if it's larger (the rest is drained unread). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
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

async function healthy(queue: JobQueue): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([queue.ping().then(() => true as const), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the request handler. It never throws: a failing queue is `503 QUEUE_UNAVAILABLE`,
 * anything unexpected `500 INTERNAL`.
 */
export function createEnqueueHandler(
  options: EnqueueApiOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { queue, secrets, analyzerVersion } = options;
  const now = options.now ?? Date.now;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (secrets.length === 0) throw new Error("the enqueue API needs at least one secret");

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const method = req.method ?? "GET";
    const path = target.split("?", 1)[0] as string;

    if (path === "/health") {
      if (method !== "GET" && method !== "HEAD") {
        send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET, HEAD" });
        return;
      }
      const ok = await healthy(queue);
      send(res, ok ? 200 : 503, { status: ok ? "ok" : "unavailable" });
      return;
    }

    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBodyBytes) {
      req.resume();
      send(res, 413, { error: "BODY_TOO_LARGE" }, { connection: "close" });
      return;
    }
    const body = await readBody(req, maxBodyBytes);
    if (body === undefined) {
      send(res, 413, { error: "BODY_TOO_LARGE" }, { connection: "close" });
      return;
    }

    const verdict = verifyRequest(
      secrets,
      { method, path: target, body },
      { timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER] },
      now(),
    );
    if (!verdict.ok) {
      send(res, 401, { error: verdict.reason });
      return;
    }

    if (path === "/enqueue") {
      if (method !== "POST") {
        send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
        return;
      }
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/json\s*(?:;|$)/i.test(type)) {
        send(res, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        send(res, 400, { error: "INVALID_JSON" });
        return;
      }
      let request: JobRequest;
      try {
        request = parseJobRequest(parsed);
      } catch (error) {
        if (!(error instanceof JobRequestError)) throw error;
        send(res, 400, { error: "INVALID_REQUEST", message: error.message });
        return;
      }
      const id = jobIdFor(request, analyzerVersion);
      let created: boolean;
      try {
        ({ created } = await queue.add(id, request));
      } catch {
        send(res, 503, { error: "QUEUE_UNAVAILABLE" });
        return;
      }
      send(res, 202, { id, created });
      return;
    }

    const jobPath = JOB_PATH.exec(path);
    if (jobPath !== null) {
      if (method !== "GET") {
        send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET" });
        return;
      }
      const id = jobPath[1] as string;
      if (!JOB_ID.test(id)) {
        send(res, 404, { error: "JOB_NOT_FOUND" });
        return;
      }
      let status: JobStatus | undefined;
      try {
        status = await queue.get(id);
      } catch {
        send(res, 503, { error: "QUEUE_UNAVAILABLE" });
        return;
      }
      if (status === undefined) send(res, 404, { error: "JOB_NOT_FOUND" });
      else send(res, 200, publicStatus(status));
      return;
    }

    send(res, 404, { error: "NOT_FOUND" });
  }

  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "INTERNAL" });
      else res.destroy();
    });
  };
}

/**
 * An HTTP server around {@link createEnqueueHandler} with tight timeouts (headers 10 s, whole
 * request 15 s), so slow clients can't hold connections open. Call `listen` on it.
 */
export function createEnqueueServer(options: EnqueueApiOptions): Server {
  const server = createServer(createEnqueueHandler(options));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
