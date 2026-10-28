import { signRequest } from "@gitinside/worker/hmac";
import {
  STAGE_PROGRESS,
  isAnalyzerStep,
  type AnalyzerStep,
  type JobStage,
} from "@gitinside/worker/progress";

/**
 * The web app's side of the worker's enqueue API (docs/DESIGN.md §11, ADR-0060, ADR-0066,
 * ADR-0067): `POST /enqueue` and `GET /jobs/:id`. Every request is signed with
 * `@gitinside/worker/hmac`, the same code the worker verifies with, over the exact bytes and
 * path sent.
 */

/** Options for {@link createWorkerClient}. */
export interface WorkerClientOptions {
  /** The enqueue API's origin, e.g. `https://worker.gitinside.abhinavgonthina.dev`. */
  url: string;
  /** `ENQUEUE_HMAC_SECRET`. */
  secret: string;
  /** Each request gives up after this long. Default 5 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Clock for the signature (tests fix it). Default `Date.now`. */
  now?: () => number;
}

/** A public analysis job to add. */
export interface AnalyzeJob {
  owner: string;
  repo: string;
  sha: string;
}

/** Thrown when the worker can't be reached or refuses; `reason` is for logs, never secret. */
export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
  constructor(readonly reason: string) {
    super(`worker unavailable: ${reason}`);
  }
}

/** A job's status from `GET /jobs/:id`, checked field by field (ADR-0060, ADR-0064). */
export interface WorkerJobStatus {
  id: string;
  kind: "analyze" | "diff";
  state: "queued" | "running" | "done" | "failed";
  stage?: JobStage;
  progress?: number;
  step?: AnalyzerStep;
  count?: number;
  position?: number;
  errorCode?: string;
}

/** The enqueue API, as the web app uses it. */
export interface WorkerClient {
  /** Add the job (or find the one already covering this commit): `{ id, created }`. */
  enqueue(job: AnalyzeJob): Promise<{ id: string; created: boolean }>;
  /** The job's status, or `undefined` if the worker doesn't know it (never added, or expired). */
  status(id: string): Promise<WorkerJobStatus | undefined>;
}

const JOB_ID = /^(?:analyze|diff)-[0-9a-f]{32}$/;
const STATES = new Set(["queued", "running", "done", "failed"]);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The status in `value` if every field is what the API documents, else `undefined`. Only the
 * documented fields are copied, so nothing unexpected from the worker reaches a browser.
 */
export function parseJobStatus(value: unknown): WorkerJobStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { id, kind, state, stage, progress, step, count, position, errorCode } = value as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || !JOB_ID.test(id)) return undefined;
  if (kind !== "analyze" && kind !== "diff") return undefined;
  if (typeof state !== "string" || !STATES.has(state)) return undefined;
  if (stage !== undefined && !(typeof stage === "string" && Object.hasOwn(STAGE_PROGRESS, stage))) {
    return undefined;
  }
  if (progress !== undefined && !(isCount(progress) && progress <= 100)) return undefined;
  if (step !== undefined && !isAnalyzerStep(step)) return undefined;
  if (count !== undefined && !isCount(count)) return undefined;
  if (position !== undefined && !isCount(position)) return undefined;
  if (errorCode !== undefined && !(typeof errorCode === "string" && CODE.test(errorCode))) {
    return undefined;
  }
  return {
    id,
    kind,
    state: state as WorkerJobStatus["state"],
    ...(stage === undefined ? {} : { stage: stage as JobStage }),
    ...(progress === undefined ? {} : { progress }),
    ...(step === undefined ? {} : { step }),
    ...(count === undefined ? {} : { count }),
    ...(position === undefined ? {} : { position }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/** A client for the enqueue API at `options.url`. */
export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.url.endsWith("/") ? options.url : `${options.url}/`;

  /** One signed request; a network failure or timeout is {@link WorkerUnavailableError}. */
  async function send(method: "GET" | "POST", path: string, json?: object): Promise<Response> {
    const endpoint = new URL(path, base);
    const body =
      json === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(json));
    const headers = signRequest(
      options.secret,
      { method, path: endpoint.pathname + endpoint.search, body },
      now(),
    );
    try {
      return await doFetch(endpoint, {
        method,
        headers: json === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(json === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
    } catch {
      throw new WorkerUnavailableError("request failed");
    }
  }

  return {
    async status(id) {
      // An ID the worker could never have issued isn't worth a request.
      if (!JOB_ID.test(id)) return undefined;
      const response = await send("GET", `jobs/${id}`);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new WorkerUnavailableError(`status ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new WorkerUnavailableError("malformed answer");
      }
      const status = parseJobStatus(value);
      if (status === undefined || status.id !== id) {
        throw new WorkerUnavailableError("malformed answer");
      }
      return status;
    },

    async enqueue(job) {
      const response = await send("POST", "enqueue", { kind: "analyze", ...job });
      if (response.status !== 202) {
        await response.body?.cancel().catch(() => undefined);
        throw new WorkerUnavailableError(`status ${response.status}`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new WorkerUnavailableError("malformed answer");
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        !("created" in value) ||
        typeof value.id !== "string" ||
        !JOB_ID.test(value.id) ||
        typeof value.created !== "boolean"
      ) {
        throw new WorkerUnavailableError("malformed answer");
      }
      return { id: value.id, created: value.created };
    },
  };
}
