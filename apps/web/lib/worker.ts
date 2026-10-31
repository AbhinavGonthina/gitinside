import { signRequest } from "@gitinside/worker/hmac";

/**
 * The web app's side of the worker's enqueue API (docs/DESIGN.md §11, ADR-0060, ADR-0066):
 * `POST /enqueue`. A job's status is read from its database row instead (ADR-0139). Every
 * request is signed with `@gitinside/worker/hmac`, the same code the worker verifies with,
 * over the exact bytes and path sent.
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

/** The enqueue API, as the web app uses it. */
export interface WorkerClient {
  /** Add the job (or find the one already covering this commit): `{ id, created }`. */
  enqueue(job: AnalyzeJob): Promise<{ id: string; created: boolean }>;
}

const JOB_ID = /^(?:analyze|diff)-[0-9a-f]{32}$/;

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
