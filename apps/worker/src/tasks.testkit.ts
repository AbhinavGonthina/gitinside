import { signRequest } from "./hmac.js";
import { RETRY_COUNT_HEADER, RUN_PATH } from "./run.js";

/**
 * A fake Cloud Tasks for tests and local dev (ADR-0114): builds a task the way the website's
 * `createTask` does (apps/web/lib/cloudTasks.ts: the job JSON, HMAC-signed for `POST /run`,
 * base64 in `httpRequest.body`) and pushes it the way Cloud Tasks does: a POST with the
 * task's headers plus `X-CloudTasks-TaskRetryCount` (0 on the first attempt), and again on
 * any answer that isn't 2xx, up to `maxAttempts` (the queue's setting, M5.17e). No backoff.
 */

/** The part of a Cloud Tasks task that the push uses. */
export interface FakeTask {
  httpRequest: {
    url: string;
    httpMethod: "POST";
    headers: Record<string, string>;
    /** Base64. */
    body: string;
  };
}

/** One delivery attempt and the worker's answer. */
export interface Delivery {
  status: number;
  body: unknown;
}

/** A task for `job` aimed at the worker at `origin`, signed with `secret` at `nowMs`. */
export function fakeTask(
  origin: string,
  job: object,
  secret: string,
  nowMs: number = Date.now(),
): FakeTask {
  const body = new TextEncoder().encode(JSON.stringify(job));
  return {
    httpRequest: {
      url: new URL(RUN_PATH, origin).href,
      httpMethod: "POST",
      headers: {
        "content-type": "application/json",
        ...signRequest(secret, { method: "POST", path: RUN_PATH, body }, nowMs),
      },
      body: Buffer.from(body).toString("base64"),
    },
  };
}

/** Push `task` until the worker answers 2xx or `maxAttempts` deliveries were made. */
export async function pushTask(task: FakeTask, maxAttempts = 3): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  for (let retry = 0; retry < maxAttempts; retry++) {
    const response = await fetch(task.httpRequest.url, {
      method: task.httpRequest.httpMethod,
      headers: {
        ...task.httpRequest.headers,
        [RETRY_COUNT_HEADER]: String(retry),
        // Cloud Run's IAM checks this before the container sees the request; the worker ignores it.
        authorization: "Bearer fake-oidc-token",
      },
      body: Buffer.from(task.httpRequest.body, "base64"),
    });
    const text = await response.text();
    deliveries.push({ status: response.status, body: text === "" ? undefined : JSON.parse(text) });
    if (response.ok) break;
  }
  return deliveries;
}
