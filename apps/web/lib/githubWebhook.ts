import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DeletedInstallationError,
  deleteInstallationData,
  findStoredAnalysis,
  linkInstallationRepos,
  queuePullRequestDiff,
  recordPullRequestHead,
  upsertInstallation,
  type AnyDatabase,
  type InstallationDeletion,
  type InstallationFacts,
} from "@gitinside/db";
import { jobIdFor } from "@gitinside/worker/request";
import type { ObjectStore } from "@gitinside/worker/storage";
import { readBody } from "./body";
import { taskIdFor, type TaskQueue } from "./cloudTasks";
import type { CodeSizeCache } from "./codeSize";
import {
  countTaskOperation,
  findAnalysisToQueue,
  InstallationRefusedError,
  QUEUE_UNAVAILABLE,
  storeQueueRepo,
  type QueueRepo,
  type StoreRepo,
} from "./enqueue";
import type { GitHubOptions } from "./github";
import { field, LOGIN } from "./githubOAuth";
import { queueHead } from "./repoView";
import { WorkerUnavailableError, type DiffJob } from "./worker";

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
 * - **Pull requests (M8.6d2, ADR-0245):** `pull_request` `opened`, `synchronize`, and
 *   `reopened` queue the pull request's diff job. The installation must be stored and not
 *   suspended (else `202` ignored, nothing written); the repo is stored from the payload and
 *   linked to it; `recordPullRequestHead` records the base and head, ordered by GitHub's
 *   `updated_at`; and for a current pair without a diff, `queuePullRequestDiff` names the job
 *   and one task is created, named from that job's queue time, so a redelivery recreates the
 *   same name and Cloud Tasks refuses it. No queue configured, or the task can't be created:
 *   `503`, so GitHub shows the delivery failed and "Redeliver" can queue it (GitHub doesn't
 *   retry on its own). An `edited` that retargeted the base (`changes.base`, M8.10c) is a new
 *   pair and is handled the same way; other edits and other actions answer `202` ignored.
 * - **Pushes (M8.7, ADR-0246):** a `push` to the default branch of a repo with a finished
 *   analysis queues its new commit through the installation, under check-on-view's rules and
 *   the repo's hourly charge (`queueHead`), so README images catch up without waiting for a
 *   view. The installation must be stored and not suspended (else `202` ignored); other
 *   branches, deleted branches, and repos never analyzed are ignored, nothing written. A task
 *   that can't be created, or no queue when one is needed: `503`, as for pull requests.
 * - Any other event answers `202` `"ignored"`.
 * - **Every write is idempotent,** so a redelivered event (GitHub's "Redeliver", or a retry
 *   after our `500`) changes nothing twice, and **deletions stay done** (M8.10e2a, ADR-0240):
 *   an uninstalled installation leaves a tombstone, so any later `installation` or
 *   `installation_repositories` store for it answers `202` ignored (`INSTALLATION_DELETED`),
 *   and a repo removed from an installation isn't linked to it again, by a `pull_request` or
 *   `push` delivery (`202` ignored, `REPO_NOT_INSTALLED`) or a replayed `created`, until GitHub
 *   sends `added`.
 * - **What a replay still changes, stated:** deliveries can arrive out of order, and neither
 *   suspensions nor `added` carry an order we can trust. The stored suspension is the last one
 *   received, and a replayed `added` after `removed` links stored repos again. Neither grants
 *   access: GitHub refuses tokens for a suspended installation and for a repo outside it
 *   (ADR-0224), a stale suspension only refuses our own queueing, and the next event, install
 *   return, or private Analyze stores GitHub's own answer again.
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
  /**
   * Where pull requests' diff jobs and pushes' analyses go; without it, a `pull_request`
   * delivery, or a `push` that would queue, gets `503`.
   */
  queue?: Pick<TaskQueue, "createTask">;
  /** `@gitinside/analyzer/version`: part of a job's ID and an analysis row's key. */
  analyzerVersion: string;
  /** The server's GitHub token, for a pushed public repo's code count (`findTooMuchCode`). */
  github?: GitHubOptions;
  /** GitHub's code counts by commit, shared with the pages; without it, asked every time. */
  codeSizes?: CodeSizeCache;
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

/** The pull request actions that queue a diff: a new or reopened pull request, or a new head. */
const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/**
 * Whether a `pull_request` action queues a diff: one of {@link PULL_REQUEST_ACTIONS}, or an
 * `edited` that retargeted the base (M8.10c): GitHub sends `changes.base` (`ref` and `sha`
 * `from`) only then, beside the new base in `pull_request.base`. A title or body edit leaves
 * the pair as it was, so it's ignored like any other action.
 */
function queuesDiff(payload: unknown, action: string): boolean {
  if (PULL_REQUEST_ACTIONS.has(action)) return true;
  if (action !== "edited") return false;
  const base = field(field(payload, "changes"), "base");
  return typeof base === "object" && base !== null && !Array.isArray(base);
}

/** A `pull_request` event's facts, read in full before anything is written. */
interface PullRequestEvent {
  repo: StoreRepo & { installationId: number };
  number: number;
  baseSha: string;
  headSha: string;
  headAt: Date;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

function sha(value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new PayloadError(`no ${what} SHA`);
  return value;
}

/** The `repository` object of a `pull_request` or `push` event, read through its installation. */
function readRepository(payload: unknown): StoreRepo & { installationId: number } {
  const repository = field(payload, "repository");
  const owner = field(field(repository, "owner"), "login");
  const name = field(repository, "name");
  const isPrivate = field(repository, "private");
  const defaultBranch = field(repository, "default_branch");
  if (typeof owner !== "string" || !LOGIN.test(owner)) throw new PayloadError("no repo owner");
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") {
    throw new PayloadError("no repo name");
  }
  if (typeof isPrivate !== "boolean") throw new PayloadError("no repo visibility");
  if (typeof defaultBranch !== "string" || defaultBranch === "" || defaultBranch.length > 255) {
    throw new PayloadError("no default branch");
  }
  return {
    providerRepoId: positiveId(field(repository, "id"), "repo ID"),
    owner,
    name,
    visibility: isPrivate ? "private" : "public",
    defaultBranch,
    installationId: installationId(payload),
  };
}

function readPullRequest(payload: unknown): PullRequestEvent {
  const repo = readRepository(payload);
  const pullRequest = field(payload, "pull_request");
  const updated = field(pullRequest, "updated_at");
  const headAt = typeof updated === "string" ? new Date(updated) : new Date(NaN);
  if (Number.isNaN(headAt.getTime())) throw new PayloadError("no updated_at");
  return {
    repo,
    number: positiveId(field(pullRequest, "number"), "pull request number"),
    baseSha: sha(field(field(pullRequest, "base"), "sha"), "base"),
    headSha: sha(field(field(pullRequest, "head"), "sha"), "head"),
    headAt,
  };
}

/** The queue is missing or refused the task: GitHub should show the delivery failed. */
class QueueUnavailableError extends Error {
  override name = "QueueUnavailableError";
}

/**
 * What a handled `pull_request` delivery did about the diff: `queued` (a task created),
 * `already-queued` (its name was used: a redelivery), `diffed` (the pair has its diff),
 * `stale` (an event older than the recorded one), or `moved` (the record changed between the
 * two writes: a newer event or the diff landed).
 */
type DiffQueueing = "queued" | "already-queued" | "diffed" | "stale" | "moved";

/** Record a pull request's new pair and queue its diff job (ADR-0245). */
async function pullRequest(
  payload: unknown,
  action: string,
  deps: WebhookDeps,
): Promise<Dispatched> {
  if (!queuesDiff(payload, action)) return { outcome: "ignored", action };
  const event = readPullRequest(payload);
  const { db, queue } = deps;
  if (queue === undefined) throw new QueueUnavailableError("no queue");
  let repoId: string;
  try {
    ({ id: repoId } = await storeQueueRepo(db, event.repo));
  } catch (error) {
    // Uninstalled, never recorded, or suspended: GitHub won't mint its token anyway.
    if (error instanceof InstallationRefusedError) {
      return { outcome: "ignored", action, detail: error.code };
    }
    throw error;
  }
  const pair = { repoId, number: event.number, baseSha: event.baseSha, headSha: event.headSha };
  const record = await recordPullRequestHead(db, { ...pair, headAt: event.headAt });
  if (record === undefined) return diffDone(action, "stale");
  if (record.diffKey !== null) return diffDone(action, "diffed");
  const job: DiffJob = {
    kind: "diff",
    owner: event.repo.owner,
    repo: event.repo.name,
    sha: event.headSha,
    baseSha: event.baseSha,
    installationId: event.repo.installationId,
  };
  const jobId = jobIdFor(job, deps.analyzerVersion);
  const queuedAt = await queuePullRequestDiff(db, { ...pair, jobId });
  if (queuedAt === undefined) return diffDone(action, "moved");
  let created: boolean;
  try {
    ({ created } = await queue.createTask(job, taskIdFor(jobId, queuedAt)));
  } catch (error) {
    await countTaskOperation(db);
    // The record keeps naming the job: a redelivery makes the same task name and creates it.
    if (error instanceof WorkerUnavailableError) throw new QueueUnavailableError(error.reason);
    throw error;
  }
  await countTaskOperation(db);
  return diffDone(action, created ? "queued" : "already-queued");
}

const diffDone = (action: string, diff: DiffQueueing): Dispatched => ({
  outcome: "ok",
  action,
  detail: diff,
});

/** A `push` event's facts: the repo, the ref pushed, and its new commit (absent if deleted). */
interface PushEvent {
  repo: QueueRepo & { installationId: number };
  ref: string;
  deleted: boolean;
}

/** Longest ref read: `refs/heads/` and a branch name as long as a default branch may be. */
const MAX_REF_LENGTH = "refs/heads/".length + 255;

function readPush(payload: unknown): PushEvent {
  const repo = readRepository(payload);
  const ref = field(payload, "ref");
  const deleted = field(payload, "deleted");
  // Only compared with the default branch's ref, never stored or logged.
  if (typeof ref !== "string" || !ref.startsWith("refs/") || ref.length > MAX_REF_LENGTH) {
    throw new PayloadError("no ref");
  }
  if (typeof deleted !== "boolean") throw new PayloadError("no deleted flag");
  // A deleted ref's `after` is forty zeros: no commit to read.
  const after = deleted ? "0".repeat(40) : sha(field(payload, "after"), "after");
  const size = field(field(payload, "repository"), "size");
  const sizeKb = typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
  return { repo: { ...repo, sha: after, ...(sizeKb !== null && { sizeKb }) }, ref, deleted };
}

/**
 * Analyze a pushed default branch's new commit at once (M8.7, ADR-0246), so a README's badge
 * and live image are up to date by their next draw instead of being re-analyzed on that view.
 * Only a repo with a finished analysis (someone already asked for its diagram), and under
 * check-on-view's own rules and charge (`queueHead`: size hold, compute pause, the repo's six
 * new commits an hour), through the installation that sent the push. Other branches, deleted
 * branches, and repos never analyzed are ignored, nothing written.
 */
async function push(payload: unknown, deps: WebhookDeps): Promise<Dispatched> {
  const event = readPush(payload);
  const { repo } = event;
  if (event.deleted) return { outcome: "ignored", detail: "deleted" };
  if (event.ref !== `refs/heads/${repo.defaultBranch}`) {
    return { outcome: "ignored", detail: "other-branch" };
  }
  const { db, queue, analyzerVersion } = deps;
  const { providerRepoId } = repo;
  if ((await findStoredAnalysis(db, { providerRepoId })) === undefined) {
    return { outcome: "ignored", detail: "not-analyzed" };
  }
  if (queue === undefined) throw new QueueUnavailableError("no queue");
  const existing = await findAnalysisToQueue(db, {
    providerRepoId,
    sha: repo.sha,
    analyzerVersion,
  });
  if (existing?.status === "done") return { outcome: "ok", detail: "done" };
  // Failed for good: as on a page, not re-run on every push ("Analyze again" can).
  if (existing?.status === "failed" && existing.errorCode !== QUEUE_UNAVAILABLE) {
    return { outcome: "ok", detail: "failed" };
  }
  const inFlight = existing?.status === "queued" || existing?.status === "running";
  // GitHub's code count by the server's token, which only sees public repos (else unknown).
  const github = repo.visibility === "public" ? (deps.github ?? {}) : undefined;
  const next = await queueHead(
    repo,
    inFlight,
    { db, queue, analyzerVersion, ...(deps.codeSizes && { codeSizes: deps.codeSizes }) },
    github,
  );
  switch (next.state) {
    case "done":
      return { outcome: "ok", detail: "done" };
    case "updating":
      return { outcome: "ok", detail: "updating" };
    default:
      if (next.reason === "unavailable") throw new QueueUnavailableError("task not created");
      // Uninstalled or suspended: GitHub won't mint its token anyway; nothing was written.
      if (next.reason === "failed") return { outcome: "ignored", detail: next.errorCode };
      return { outcome: "ok", detail: next.reason };
  }
}

/** What {@link dispatch} did, for the answer and the log. */
interface Dispatched {
  outcome: WebhookOutcome;
  action?: string;
  /** Why it was ignored, or what happened to a pull request's diff. */
  detail?: string;
  deletion?: Deletion;
}

async function dispatch(event: string, payload: unknown, deps: WebhookDeps): Promise<Dispatched> {
  const { db } = deps;
  if (event === "ping") return { outcome: "ok" };
  if (event === "push") return push(payload, deps);
  if (event === "pull_request") {
    const action = field(payload, "action");
    if (typeof action !== "string") throw new PayloadError("no action");
    return pullRequest(payload, action, deps);
  }
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
  try {
    await db.transaction(async (tx) => {
      await upsertInstallation(tx, facts);
      await linkInstallationRepos(tx, facts.githubInstallationId, repos, {
        added: event === "installation_repositories",
      });
    });
  } catch (error) {
    // Uninstalled (M8.10e2a): GitHub never reuses the ID, so this delivery is stale.
    if (error instanceof DeletedInstallationError) {
      return { outcome: "ignored", action, detail: "INSTALLATION_DELETED" };
    }
    throw error;
  }
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
    const { outcome, action, detail, deletion } = await dispatch(event, payload, deps);
    if (deletion === undefined) log({ delivery, name: event, action, outcome, detail });
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
    if (error instanceof QueueUnavailableError) {
      log({ delivery, name: event, outcome: "unavailable", reason: error.message });
      return json(503, { error: "QUEUE_UNAVAILABLE" });
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
