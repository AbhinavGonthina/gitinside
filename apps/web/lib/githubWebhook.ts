import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deleteInstallationData,
  linkInstallationRepos,
  upsertInstallation,
  type AnyDatabase,
  type InstallationDeletion,
  type InstallationFacts,
} from "@gitinside/db";
import type { ObjectStore } from "@gitinside/worker/storage";
import { readBody } from "./body";
import { field, LOGIN } from "./githubOAuth";

/**
 * `POST /api/github/webhook` (ADR-0220, ADR-0224): the GitHub App's deliveries.
 *
 * - **Signed or refused.** GitHub signs each body with HMAC-SHA256 under the app's webhook
 *   secret (`X-Hub-Signature-256: sha256=<hex>`). The raw bytes are checked against the
 *   current secret and, during a rotation, the previous one, in constant time, before
 *   anything is parsed (SECURITY.md T8). No secret configured: `503`, nothing read.
 * - **Bodies over {@link MAX_WEBHOOK_BYTES}** are refused (`413`) unread or as soon as they
 *   pass it.
 * - **Handled (M8.3a):** `installation` `created`, `new_permissions_accepted`, `suspend`, and
 *   `unsuspend` store the installation's account and suspension, and `created` links the
 *   stored repos it lists; `installation_repositories` `added` does the same for the repos
 *   added. `ping` answers `200`.
 * - **Deletion (M8.5a, ADR-0240):** `installation` `deleted` and `installation_repositories`
 *   `removed` delete the private data those repos leave behind at once (SPEC §3): first
 *   the rows, in one transaction (`deleteInstallationData`), then every object under the
 *   prefixes it returns, listed and deleted from the bucket before answering. An object
 *   delete that fails is logged (`webhook_purge_failed`, counts only) and doesn't fail the
 *   delivery: no row names it any more, so retention's hourly orphan sweep deletes it within
 *   about two hours (the hour's grace plus the run's period), and a redelivery couldn't find
 *   a deleted repo's prefix again anyway.
 * - `pull_request` (M8.6), `push` (M8.7), and any other event answer `202` `"ignored"`.
 * - **Every write is idempotent,** so a redelivered event (GitHub's "Redeliver", or a retry
 *   after our `500`) changes nothing twice. Deliveries can arrive out of order; the stored
 *   suspension is the last one received, and GitHub itself refuses tokens for a suspended
 *   installation, so a stale flag can't grant access (ADR-0224).
 * - A signed body out of shape is `400`; a database failure `500`, logged by name only.
 */

/**
 * Largest delivery read. GitHub caps payloads at 25 MB, but Vercel's functions take 4.5 MB;
 * an `installation` `created` event lists every repo it covers (about 150 bytes each), so
 * this holds about 25,000 repos.
 */
export const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;

/** The header carrying GitHub's signature. */
export const SIGNATURE_HEADER = "x-hub-signature-256";
/** The header naming the event. */
export const EVENT_HEADER = "x-github-event";
/** The header carrying the delivery's GUID (logged, so a delivery can be found on GitHub). */
export const DELIVERY_HEADER = "x-github-delivery";

/** What the webhook route needs. */
export interface WebhookDeps {
  db: AnyDatabase;
  /** The snapshot bucket, to delete a removed installation's objects. */
  store: Pick<ObjectStore, "list" | "delete">;
  /** The current webhook secret first, then the previous one during a rotation. */
  secrets: readonly string[];
}

/** The answer's `status`: what was done with the delivery. */
export type WebhookOutcome = "ok" | "ignored";

/** Object deletes in flight at once while purging. */
const PURGE_CONCURRENCY = 8;

/** What {@link purgeObjects} did. */
export interface PurgeReport {
  deleted: number;
  /** Deletes that failed, plus one per prefix whose listing failed. */
  failed: number;
}

/**
 * Delete every object under each of `prefixes`, never throwing: a failed listing or delete is
 * counted and the rest go on. Exported for its tests.
 */
export async function purgeObjects(
  store: Pick<ObjectStore, "list" | "delete">,
  prefixes: readonly string[],
): Promise<PurgeReport> {
  const report: PurgeReport = { deleted: 0, failed: 0 };
  for (const prefix of prefixes) {
    const keys: string[] = [];
    try {
      for await (const object of store.list(prefix)) keys.push(object.key);
    } catch {
      report.failed++;
    }
    let next = 0;
    const lane = async () => {
      while (next < keys.length) {
        const key = keys[next++] as string;
        try {
          await store.delete(key);
          report.deleted++;
        } catch {
          report.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: PURGE_CONCURRENCY }, lane));
  }
  return report;
}

type Body = { status: WebhookOutcome } | { error: string };

function json(status: number, body: Body): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * Whether `header` (`sha256=<64 lowercase hex>`) is the HMAC-SHA256 of `body` under one of
 * `secrets`. Every secret is checked, with no early exit, so timing doesn't say which matched.
 */
export function verifySignature(
  secrets: readonly string[],
  body: Uint8Array,
  header: string | null,
): boolean {
  const hex = header === null ? undefined : SIGNATURE.exec(header)?.[1];
  if (hex === undefined) return false;
  const given = Buffer.from(hex, "hex");
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(body).digest();
    if (timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}

/** A delivery's body that isn't what its event promises. */
class PayloadError extends Error {
  override name = "PayloadError";
}

function positiveId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PayloadError(`no ${what}`);
  }
  return value;
}

/** The `installation` object every installation event carries. */
function readInstallation(payload: unknown): InstallationFacts {
  const installation = field(payload, "installation");
  const account = field(installation, "account");
  const login = field(account, "login");
  const type = field(account, "type");
  const suspended = field(installation, "suspended_at");
  if (typeof login !== "string" || !LOGIN.test(login)) throw new PayloadError("no account login");
  if (type !== "User" && type !== "Organization") throw new PayloadError("no account type");
  let suspendedAt: Date | null = null;
  if (suspended !== null && suspended !== undefined) {
    suspendedAt = typeof suspended === "string" ? new Date(suspended) : new Date(NaN);
    if (Number.isNaN(suspendedAt.getTime())) throw new PayloadError("a bad suspended_at");
  }
  return {
    githubInstallationId: positiveId(field(installation, "id"), "installation ID"),
    accountId: positiveId(field(account, "id"), "account ID"),
    accountLogin: login,
    accountType: type,
    suspendedAt,
  };
}

/** GitHub's IDs of the repos in `payload[name]`; an absent list is empty. */
function repoIds(payload: unknown, name: string): number[] {
  const list = field(payload, name);
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new PayloadError(`no ${name}`);
  return list.map((repo) => positiveId(field(repo, "id"), "repo ID"));
}

/** What each event handles: an action stores (`store`), deletes (`delete`), or is ignored. */
const INSTALLATION_ACTIONS: Record<string, "store" | "delete" | undefined> = {
  created: "store",
  new_permissions_accepted: "store",
  suspend: "store",
  unsuspend: "store",
  deleted: "delete",
};
const REPOSITORIES_ACTIONS: Record<string, "store" | "delete" | undefined> = {
  added: "store",
  removed: "delete",
};

/** The installation's ID alone: a deletion needs nothing else, and stores nothing. */
function installationId(payload: unknown): number {
  return positiveId(field(field(payload, "installation"), "id"), "installation ID");
}

async function dispatch(
  event: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<{ outcome: WebhookOutcome; action?: string; deletion?: Deletion }> {
  const { db } = deps;
  if (event === "ping") return { outcome: "ok" };
  if (event !== "installation" && event !== "installation_repositories") {
    return { outcome: "ignored" };
  }
  const action = field(payload, "action");
  if (typeof action !== "string") throw new PayloadError("no action");
  const actions = event === "installation" ? INSTALLATION_ACTIONS : REPOSITORIES_ACTIONS;
  const handling = Object.hasOwn(actions, action) ? actions[action] : undefined;
  if (handling === undefined) return { outcome: "ignored", action };

  if (handling === "delete") {
    const id = installationId(payload);
    const scope = event === "installation" ? "all" : repoIds(payload, "repositories_removed");
    const rows = await deleteInstallationData(db, id, scope);
    const purge = await purgeObjects(deps.store, rows.prefixes);
    return { outcome: "ok", action, deletion: { ...rows, ...purge } };
  }

  // Read everything before writing anything, so a bad payload writes nothing.
  const facts = readInstallation(payload);
  const repos =
    event === "installation"
      ? action === "created"
        ? repoIds(payload, "repositories")
        : []
      : repoIds(payload, "repositories_added");
  await db.transaction(async (tx) => {
    await upsertInstallation(tx, facts);
    await linkInstallationRepos(tx, facts.githubInstallationId, repos);
  });
  return { outcome: "ok", action };
}

/** What a deletion did: rows, then objects. */
type Deletion = InstallationDeletion & PurgeReport;

function log(fields: Record<string, string | number | boolean | undefined>): void {
  console.log(JSON.stringify({ event: "github_webhook", ...fields }));
}

const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Answer one webhook delivery. `deps` is `undefined` when the webhook secret or the database
 * isn't configured: every delivery then gets `503`, and GitHub shows it failed.
 */
export async function handleWebhook(
  request: Request,
  deps: WebhookDeps | undefined,
): Promise<Response> {
  if (deps === undefined) return json(503, { error: "UNAVAILABLE" });
  const bytes = await readBody(request, MAX_WEBHOOK_BYTES);
  if (bytes === undefined) return json(413, { error: "BODY_TOO_LARGE" });
  if (!verifySignature(deps.secrets, bytes, request.headers.get(SIGNATURE_HEADER))) {
    return json(401, { error: "BAD_SIGNATURE" });
  }
  // Signed by GitHub from here on; still checked, never trusted to be well formed.
  const rawDelivery = request.headers.get(DELIVERY_HEADER) ?? "";
  const delivery = DELIVERY.test(rawDelivery) ? rawDelivery : undefined;
  const event = request.headers.get(EVENT_HEADER) ?? "";
  if (!/^[a-z_]{1,64}$/.test(event)) return json(400, { error: "BAD_EVENT" });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json(400, { error: "INVALID_JSON" });
  }
  try {
    const { outcome, action, deletion } = await dispatch(event, payload, deps);
    if (deletion === undefined) log({ delivery, name: event, action, outcome });
    else {
      const { prefixes, ...counts } = deletion;
      log({ delivery, name: event, action, outcome, prefixes: prefixes.length, ...counts });
      if (deletion.failed > 0) {
        console.error(
          JSON.stringify({ event: "webhook_purge_failed", delivery, failed: deletion.failed }),
        );
      }
    }
    return json(outcome === "ok" ? 200 : 202, { status: outcome });
  } catch (error) {
    if (error instanceof PayloadError) {
      log({ delivery, name: event, outcome: "invalid", reason: error.message });
      return json(400, { error: "INVALID_PAYLOAD" });
    }
    // Name only: a driver error's message can carry connection details.
    console.error(
      JSON.stringify({
        event: "github_webhook_failed",
        delivery,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json(500, { error: "INTERNAL" });
  }
}
