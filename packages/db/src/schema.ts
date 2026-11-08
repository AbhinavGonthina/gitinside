/**
 * GitInside's Postgres metadata schema (docs/DESIGN.md §10, ADR-0057).
 *
 * Postgres holds only metadata: which repos and commits were analyzed, job
 * state, PR records, the private-access cache, and rate-limit counters.
 * Graph snapshots live in object storage under `snapshot_key`.
 *
 * Integrity rules live in the database, not only in the app, so a buggy
 * caller can't write an impossible row:
 * - commit SHAs are 40 lowercase hex characters;
 * - a `done` analysis has a snapshot and a finish time; a `failed` one has an
 *   error code and a finish time; `queued`/`running` have neither;
 * - counts are never negative;
 * - deleting a repo or user deletes everything that hangs off it (uninstall
 *   deletes private data, SPEC §3), while deleting an installation only
 *   unlinks its repos (the uninstall flow, `deleteInstallationData`, deletes those itself).
 *
 * This file must stay self-contained (no relative imports): drizzle-kit
 * loads it directly to generate migrations.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Whether a repo is public (shared cache, indexable) or private (M8). */
export const repoVisibility = pgEnum("repo_visibility", ["public", "private"]);

/** Lifecycle of one analysis job. */
export const analysisStatus = pgEnum("analysis_status", ["queued", "running", "done", "failed"]);

/** Timestamps are always stored with their time zone. */
const timestampTz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** GitHub's numeric IDs fit in a double (< 2^53), so read them as numbers. */
const githubId = (name: string) => bigint(name, { mode: "number" });

/** A full commit SHA: 40 lowercase hex characters. */
const isSha = (column: AnyPgColumn) => sql`${column} ~ '^[0-9a-f]{40}$'`;

/**
 * A GitHub App installation (M8), as its last `installation` or `installation_repositories`
 * webhook described it (M8.3a, ADR-0224). `account_id` is GitHub's ID for the user or
 * organization it's installed on, which survives renames; `suspended_at` is set while the
 * account has suspended the app.
 */
export const installations = pgTable(
  "installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubInstallationId: githubId("github_installation_id").notNull().unique(),
    accountId: githubId("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    suspendedAt: timestampTz("suspended_at"),
    createdAt: timestampTz("created_at").notNull().defaultNow(),
    updatedAt: timestampTz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("installations_account_type_check", sql`${t.accountType} in ('User', 'Organization')`),
  ],
);

/**
 * A GitHub repository. `provider_repo_id` is GitHub's ID, which survives
 * renames; `owner`/`name` are unique ignoring case, as on GitHub.
 */
export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerRepoId: githubId("provider_repo_id").notNull().unique(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    visibility: repoVisibility("visibility").notNull(),
    installationId: uuid("installation_id").references(() => installations.id, {
      onDelete: "set null",
    }),
    defaultBranch: text("default_branch").notNull(),
    createdAt: timestampTz("created_at").notNull().defaultNow(),
    updatedAt: timestampTz("updated_at").notNull().defaultNow(),
    /**
     * The commit whose new analysis `/api/analyze` last let through for this repo, and when
     * (the database's clock, whole milliseconds): one new analysis per repo per period,
     * whoever asks (#11, ADR-0155). Both null when no claim stands.
     */
    analysisClaimSha: text("analysis_claim_sha"),
    analysisClaimedAt: timestampTz("analysis_claimed_at"),
  },
  (t) => [
    uniqueIndex("repos_owner_name_lower_key").on(sql`lower(${t.owner})`, sql`lower(${t.name})`),
    index("repos_installation_id_idx").on(t.installationId),
    check("repos_analysis_claim_sha_check", isSha(t.analysisClaimSha)),
    check(
      "repos_analysis_claim_check",
      sql`(${t.analysisClaimSha} is null) = (${t.analysisClaimedAt} is null)`,
    ),
  ],
);

/** Counts recorded when an analysis finishes, plus per-stage timings in ms (DESIGN §13). */
export interface AnalysisStats {
  /** Source files analyzed (the graph's `file` nodes). */
  files: number;
  nodes: number;
  edges: number;
  unresolved: number;
  warnings?: number;
  /** `architecture.json` size, and the gzipped object's size (what counts against the bucket's quota). */
  graphBytes?: number;
  snapshotBytes?: number;
  /** Analyzer stages. `jsonb` reorders keys, so this doesn't keep the stage order. */
  stageMs?: Record<string, number>;
  /** Worker stages: download + extract, the analysis child, the snapshot upload. */
  jobMs?: { download: number; analyze: number; upload: number };
  /** The analysis child's peak RSS and final V8 heap, in bytes (the memory budget, ADR-0146). */
  peakRssBytes?: number;
  heapBytes?: number;
  /** The child's main-thread collector pauses in ms by kind (`minor`, `major`, …; M5.13a5). */
  gcMs?: Record<string, number>;
}

/**
 * Where a running attempt is (ADR-0064, ADR-0139, ADR-0140), as the worker writes it: its
 * stage and coarse progress (0–100), inside `analyze` the analyzer's step and its count, what
 * the attempt has found so far (#8, capped), and once estimated, the milliseconds it had left
 * when written (measured on the worker's own clock). Readers subtract the time since the row's
 * `progress_at`, on the database's clock, and check every field before showing it.
 */
export interface JobProgress {
  stage: string;
  progress: number;
  step?: string;
  count?: number;
  found?: object;
  leftMs?: number;
}

/**
 * One analysis of one commit by one analyzer version. The unique key is the
 * cache key: a new analyzer version re-analyzes, the same one reuses. The row is also the
 * analysis's job (ADR-0114, ADR-0139): its queue job ID, attempts, place in the queue, and
 * live progress, so the progress page reads Postgres rather than the queue.
 */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    status: analysisStatus("status").notNull().default("queued"),
    errorCode: text("error_code"),
    stats: jsonb("stats").$type<AnalysisStats>(),
    snapshotKey: text("snapshot_key"),
    analyzerVersion: text("analyzer_version").notNull(),
    createdAt: timestampTz("created_at").notNull().defaultNow(),
    startedAt: timestampTz("started_at"),
    finishedAt: timestampTz("finished_at"),
    /**
     * The queue's job (`analyze-<32 hex>`, derived from the commit by the worker's
     * `jobIdFor`); null until a job is known. Not unique: a repo deleted and created again
     * under the same name with the same commits gets the same ID, so readers take the newest.
     */
    jobId: text("job_id"),
    /** Attempts started (each move to `running`); back to 0 when a failed row is queued again. */
    attempts: integer("attempts").notNull().default(0),
    /** When the row last entered the queue: the queue position counts `queued` rows before it. */
    queuedAt: timestampTz("queued_at").notNull().defaultNow(),
    /** Where the running attempt is; null in every other status. */
    progress: jsonb("progress").$type<JobProgress>(),
    /** When `progress` was written, by the database's clock; null exactly when it is. */
    progressAt: timestampTz("progress_at"),
    /**
     * GitHub's repo `size` (KiB) when the website queued the row; null when GitHub didn't say
     * or the worker inserted it. After a `LIMIT_*` failure it is the size the repo must halve
     * from before it's analyzed again within the week (#11, ADR-0153).
     */
    repoSizeKb: integer("repo_size_kb"),
  },
  (t) => [
    unique("analyses_repo_sha_version_key").on(t.repoId, t.sha, t.analyzerVersion),
    index("analyses_repo_created_idx").on(t.repoId, t.createdAt),
    index("analyses_job_id_idx").on(t.jobId),
    index("analyses_queued_idx")
      .on(t.queuedAt, t.id)
      .where(sql`${t.status} = 'queued'`),
    check("analyses_sha_check", isSha(t.sha)),
    check("analyses_job_id_check", sql`${t.jobId} ~ '^analyze-[0-9a-f]{32}$'`),
    check("analyses_attempts_check", sql`${t.attempts} >= 0`),
    check("analyses_repo_size_kb_check", sql`${t.repoSizeKb} >= 0`),
    check("analyses_progress_check", sql`${t.progress} is null or ${t.status} = 'running'`),
    check("analyses_progress_at_check", sql`(${t.progress} is null) = (${t.progressAt} is null)`),
    check(
      "analyses_status_check",
      sql`case ${t.status}
        when 'queued' then ${t.snapshotKey} is null and ${t.errorCode} is null and ${t.finishedAt} is null
        when 'running' then ${t.snapshotKey} is null and ${t.errorCode} is null and ${t.finishedAt} is null and ${t.startedAt} is not null
        when 'done' then ${t.snapshotKey} is not null and ${t.errorCode} is null and ${t.finishedAt} is not null
        when 'failed' then ${t.errorCode} is not null and ${t.snapshotKey} is null and ${t.finishedAt} is not null
      end`,
    ),
  ],
);

/** A signed-in GitHub user (identity only, M8). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubUserId: githubId("github_user_id").notNull().unique(),
  login: text("login").notNull(),
  createdAt: timestampTz("created_at").notNull().defaultNow(),
});

/**
 * A signed-in browser (M8.2, ADR-0221). Its cookie holds a random token and only the token's
 * SHA-256 is stored, so reading this table signs nobody in. `github_tokens` holds the user's
 * GitHub tokens sealed by the website (AES-256-GCM under `SESSION_SECRET`, bound to this
 * row's hash); the database never sees them in clear. A session ends at `expires_at`, by the
 * database's clock, or when its row is deleted (sign-out, or the user's row).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubTokens: text("github_tokens").notNull(),
    createdAt: timestampTz("created_at").notNull().defaultNow(),
    expiresAt: timestampTz("expires_at").notNull(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
    check("sessions_token_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("sessions_expires_at_check", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * Whether a user may view a private repo, as GitHub last answered. Valid for
 * 60 s from `checked_at` (ADR-0009), by the database's clock (`access.ts`).
 */
export const accessCache = pgTable(
  "access_cache",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    allowed: boolean("allowed").notNull(),
    checkedAt: timestampTz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repoId] })],
);

/**
 * The bot's record of one pull request: the diff it posted and where (M8, ADR-0244). The
 * base and head are the newest GitHub has described (`head_at`, GitHub's `updated_at` in that
 * event); the diff's key and broken count are that pair's, set together, and the Check Run is
 * that head's. The comment is the pull request's, edited in place across heads.
 */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    headAt: timestampTz("head_at").notNull(),
    diffKey: text("diff_key"),
    brokenCount: integer("broken_count"),
    commentId: githubId("comment_id"),
    checkRunId: githubId("check_run_id"),
    createdAt: timestampTz("created_at").notNull().defaultNow(),
    updatedAt: timestampTz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("pull_requests_repo_number_key").on(t.repoId, t.number),
    check("pull_requests_number_check", sql`${t.number} > 0`),
    check("pull_requests_base_sha_check", isSha(t.baseSha)),
    check("pull_requests_head_sha_check", isSha(t.headSha)),
    check("pull_requests_broken_count_check", sql`${t.brokenCount} >= 0`),
    check("pull_requests_result_check", sql`(${t.diffKey} is null) = (${t.brokenCount} is null)`),
  ],
);

/**
 * Fixed-window counters for new analyses (SPEC §3). `key` is opaque to the
 * database: callers store a keyed hash of the IP or the user ID, never a raw
 * IP address.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestampTz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index("rate_limits_window_start_idx").on(t.windowStart),
    check("rate_limits_count_check", sql`${t.count} >= 0`),
  ],
);

/**
 * Requests made to the snapshot bucket per UTC calendar month and per process kind
 * (`worker` or `web`), counted against Oracle Object Storage's 50,000 a month (ADR-0096).
 */
export const storeRequests = pgTable(
  "store_requests",
  {
    monthStart: timestampTz("month_start").notNull(),
    source: text("source").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.monthStart, t.source] }),
    check("store_requests_source_check", sql`${t.source} in ('worker', 'web')`),
    check("store_requests_count_check", sql`${t.count} >= 0`),
  ],
);

/**
 * Google compute GitInside used per UTC calendar month, as the worker and the website count
 * it (#11, ADR-0156): the worker's billed Cloud Run instance time in ms (startup, shutdown,
 * and each push's request), its Cloud Run requests, Cloud Tasks operations (each task
 * created, each push delivered), and Secret Manager accesses (the worker's secrets, read by
 * Cloud Run at each instance start). New analyses pause at 80% of the free allowance.
 */
export const computeUsage = pgTable(
  "compute_usage",
  {
    monthStart: timestampTz("month_start").primaryKey(),
    instanceMs: bigint("instance_ms", { mode: "number" }).notNull().default(0),
    runRequests: integer("run_requests").notNull().default(0),
    taskOperations: integer("task_operations").notNull().default(0),
    secretAccesses: integer("secret_accesses").notNull().default(0),
  },
  (t) => [
    check("compute_usage_instance_ms_check", sql`${t.instanceMs} >= 0`),
    check("compute_usage_run_requests_check", sql`${t.runRequests} >= 0`),
    check("compute_usage_task_operations_check", sql`${t.taskOperations} >= 0`),
    check("compute_usage_secret_accesses_check", sql`${t.secretAccesses} >= 0`),
  ],
);

/**
 * When each periodic maintenance task last started, by the database's clock (ADR-0147).
 * The worker runs no timer of its own on Cloud Run: an instance claims a task's row at the
 * end of a job, and only one instance can win the claim for a period.
 */
export const maintenanceRuns = pgTable("maintenance_runs", {
  name: text("name").primaryKey(),
  startedAt: timestampTz("started_at").notNull(),
});
