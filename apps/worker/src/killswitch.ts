import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { WorkerLog } from "./attempt.js";
import { HEALTH_PATH, MAX_BODY_BYTES, isJson, readBody, send } from "./http.js";
import { createJsonLog } from "./log.js";

/**
 * The billing kill switch (ADR-0111, ADR-0169): Google's documented way to stop all spending
 * on a project, as a second Cloud Run service from the worker's image
 * (`node dist/killswitch-bin.js`, `infra/gcp/killswitch.json`).
 *
 * A $1 Cloud Billing budget (`infra/gcp/budget.json`) publishes its status to the Pub/Sub
 * topic `billing-alerts` several times a day, and a push subscription delivers each message
 * to `POST /budget`. When the month's cost (after credits) has reached the budget, the
 * switch unlinks the project's billing account through the Cloud Billing API
 * (`projects.updateBillingInfo` with an empty `billingAccountName`), which stops every paid
 * service in the project, the worker included. Turning billing back on is a manual step.
 *
 * **Answers.** Pub/Sub redelivers anything not answered 2xx, so:
 * - a message that isn't a budget notification is logged and acknowledged (`204`), since
 *   retrying it would never help;
 * - a notification under the budget, or one for a project whose billing is already off, is
 *   acknowledged;
 * - a failure to read the token or to call Cloud Billing is `503`, so Pub/Sub retries it.
 *
 * Only Cloud Run's IAM (the push's OIDC token, `gitinside-killswitch` as invoker) and the
 * internal ingress stand in front of it: the worst a forged push could do is turn billing
 * off, which is the switch's purpose anyway.
 */

/** Where Pub/Sub pushes budget notifications. */
export const BUDGET_PATH = "/budget";

/** The metadata server's token endpoint for the instance's own service account. */
export const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Cloud Billing's API origin. */
export const BILLING_ORIGIN = "https://cloudbilling.googleapis.com";

/** How long one Google call may take before the push is answered `503`. */
export const GOOGLE_TIMEOUT_MS = 10_000;

/** The fields of a Cloud Billing budget notification (schema 1.0) that the switch reads. */
export interface BudgetNotification {
  budgetDisplayName: string;
  /** The month's cost so far, after the credits the budget counts. */
  costAmount: number;
  budgetAmount: number;
  currencyCode: string;
}

/**
 * The budget notification inside a Pub/Sub push body, or `undefined` if the body isn't one
 * (not JSON, no `message.data`, not base64 JSON, or missing or non-finite amounts).
 */
export function parseBudgetPush(body: Buffer): BudgetNotification | undefined {
  let data: unknown;
  try {
    const push = JSON.parse(body.toString("utf8")) as { message?: { data?: unknown } };
    if (typeof push.message?.data !== "string") return undefined;
    data = JSON.parse(Buffer.from(push.message.data, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const { budgetDisplayName, costAmount, budgetAmount, currencyCode } = data as Record<
    string,
    unknown
  >;
  if (typeof costAmount !== "number" || !Number.isFinite(costAmount)) return undefined;
  if (typeof budgetAmount !== "number" || !Number.isFinite(budgetAmount)) return undefined;
  return {
    budgetDisplayName: typeof budgetDisplayName === "string" ? budgetDisplayName : "",
    costAmount,
    budgetAmount,
    currencyCode: typeof currencyCode === "string" ? currencyCode : "",
  };
}

/**
 * Whether a notification means billing must go off: the cost has reached the budget. A
 * budget of 0 or less (a misconfiguration) never triggers, so it can't disable billing on
 * the first notification of a month.
 */
export function overBudget(notification: BudgetNotification): boolean {
  return notification.budgetAmount > 0 && notification.costAmount >= notification.budgetAmount;
}

/** What {@link createKillSwitch} needs. */
export interface KillSwitchOptions {
  /** The project whose billing is unlinked (`infra/gcp`'s project ID). */
  projectId: string;
  log?: WorkerLog;
  /** Default {@link METADATA_TOKEN_URL} (tests point it at a fake). */
  tokenUrl?: string;
  /** Default {@link BILLING_ORIGIN}. */
  billingOrigin?: string;
  /** Default {@link GOOGLE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** What one push came to. */
export type KillSwitchOutcome =
  | "invalid"
  | "under_budget"
  | "already_disabled"
  | "disabled"
  | "failed";

/** Thrown for a Google call that failed; the message never holds a token. */
class GoogleError extends Error {
  override name = "GoogleError";
}

async function googleJson(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new GoogleError(`${what}: ${error instanceof Error ? error.name : "request failed"}`);
  }
  const text = await response.text();
  if (!response.ok) throw new GoogleError(`${what}: HTTP ${response.status}`);
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new GoogleError(`${what}: not a JSON object`);
}

/** The handler of one budget push, and the HTTP server around it. */
export interface KillSwitch {
  /** Decide and act on one push body. */
  handle(body: Buffer): Promise<KillSwitchOutcome>;
  /** `GET /health`, `POST /budget`; everything else 404. */
  server: Server;
}

/** Build the kill switch for `options.projectId`. */
export function createKillSwitch(options: KillSwitchOptions): KillSwitch {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? GOOGLE_TIMEOUT_MS;
  const billingUrl = `${options.billingOrigin ?? BILLING_ORIGIN}/v1/projects/${encodeURIComponent(
    options.projectId,
  )}/billingInfo`;

  async function token(): Promise<string> {
    const body = await googleJson(
      options.tokenUrl ?? METADATA_TOKEN_URL,
      { headers: { "metadata-flavor": "Google" } },
      "metadata token",
      timeoutMs,
    );
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new GoogleError("metadata token: no access_token");
    }
    return body.access_token;
  }

  async function handle(body: Buffer): Promise<KillSwitchOutcome> {
    const notification = parseBudgetPush(body);
    if (notification === undefined) {
      log({ event: "budget_push_invalid" });
      return "invalid";
    }
    const facts = {
      budget: notification.budgetDisplayName,
      cost: notification.costAmount,
      amount: notification.budgetAmount,
      currency: notification.currencyCode,
    };
    if (!overBudget(notification)) {
      log({ event: "budget_under", ...facts });
      return "under_budget";
    }
    try {
      const authorization = `Bearer ${await token()}`;
      // Google's sample reads first: unlinking an unlinked project is an error, and the
      // budget keeps notifying after billing is off.
      const info = await googleJson(
        billingUrl,
        { headers: { authorization } },
        "billing info",
        timeoutMs,
      );
      if (info.billingEnabled !== true) {
        log({ event: "billing_already_disabled", project: options.projectId, ...facts });
        return "already_disabled";
      }
      const after = await googleJson(
        billingUrl,
        {
          method: "PUT",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ billingAccountName: "" }),
        },
        "disable billing",
        timeoutMs,
      );
      if (after.billingEnabled === true) throw new GoogleError("disable billing: still enabled");
      log({ event: "billing_disabled", project: options.projectId, ...facts });
      return "disabled";
    } catch (error) {
      const message = error instanceof GoogleError ? error.message : "unexpected error";
      log({ event: "billing_disable_failed", project: options.projectId, message, ...facts });
      return "failed";
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === HEALTH_PATH && req.method === "GET") {
      send(res, 200, { status: "ok" });
      return;
    }
    if (path !== BUDGET_PATH) {
      send(res, 404, { error: "NOT_FOUND" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
      return;
    }
    if (!isJson(req)) {
      // Acknowledged: Pub/Sub always sends JSON, so redelivery wouldn't change it.
      log({ event: "budget_push_invalid" });
      res.writeHead(204).end();
      return;
    }
    readBody(req, MAX_BODY_BYTES)
      .then(async (body) => {
        const outcome = body === undefined ? "invalid" : await handle(body);
        if (body === undefined) log({ event: "budget_push_invalid" });
        if (outcome === "failed") send(res, 503, { error: "BILLING_DISABLE_FAILED" });
        else res.writeHead(204).end();
      })
      .catch(() => {
        if (!res.headersSent) send(res, 503, { error: "BILLING_DISABLE_FAILED" });
      });
  });

  return { handle, server };
}

/** What {@link killSwitchConfigFromEnv} returns. */
export interface KillSwitchConfig {
  projectId: string;
  host: string;
  port: number;
}

/** Google's project ID rule: 6–30 of lowercase letters, digits, and hyphens. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * The switch's settings: `KILLSWITCH_PROJECT_ID` (required), `HOST` (default `127.0.0.1`;
 * the image sets `0.0.0.0`), and `PORT` (default 8080; Cloud Run sets it). Throws naming
 * the variable, never its value.
 */
export function killSwitchConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): KillSwitchConfig {
  const projectId = env.KILLSWITCH_PROJECT_ID ?? "";
  if (!PROJECT_ID.test(projectId)) throw new Error("KILLSWITCH_PROJECT_ID is not a project ID");
  const port = env.PORT === undefined || env.PORT === "" ? 8080 : Number(env.PORT);
  if (!/^[1-9][0-9]{0,4}$/.test(String(port)) || port > 65535) {
    throw new Error("PORT is not a port number");
  }
  return {
    projectId,
    host: env.HOST === undefined || env.HOST === "" ? "127.0.0.1" : env.HOST,
    port,
  };
}

/** What {@link runKillSwitch} needs from the process (tests fake it). */
export interface KillSwitchIo {
  env: Readonly<Record<string, string | undefined>>;
  /** Writes one JSON log line (stdout in production). */
  write: (line: string) => void;
  onSignal: (signals: readonly NodeJS.Signals[], handler: () => void) => void;
  exit: (code: number) => void;
  /** Overrides for tests (Google's endpoints). */
  options?: Pick<KillSwitchOptions, "tokenUrl" | "billingOrigin" | "timeoutMs">;
}

/**
 * The `killswitch-bin.js` entry: read the config, listen, and close on SIGTERM or SIGINT
 * (exit 0). A bad config or a failed listen exits 1. Resolves to the listening server.
 */
export async function runKillSwitch(io: KillSwitchIo): Promise<Server | undefined> {
  const log = createJsonLog(io.write);
  let config: KillSwitchConfig;
  try {
    config = killSwitchConfigFromEnv(io.env);
  } catch (error) {
    log({ event: "config_invalid", problems: [error instanceof Error ? error.message : ""] });
    io.exit(1);
    return undefined;
  }
  const { server } = createKillSwitch({ projectId: config.projectId, log, ...io.options });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    log({ event: "startup_failed", message: error instanceof Error ? error.message : "" });
    io.exit(1);
    return undefined;
  }
  log({ event: "killswitch_ready", project: config.projectId, port: config.port });
  io.onSignal(["SIGTERM", "SIGINT"], () => {
    server.close(() => io.exit(0));
    server.closeIdleConnections();
  });
  return server;
}
