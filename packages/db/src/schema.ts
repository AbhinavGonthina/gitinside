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
 *   unlinks its repos (the uninstall flow, M8.5, deletes those itself).
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

/** A GitHub App installation (M8). */
export const installations = pgTable("installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubInstallationId: githubId("github_installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  createdAt: timestampTz("created_at").notNull().defaultNow(),
});

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
  },
  (t) => [
    uniqueIndex("repos_owner_name_lower_key").on(sql`lower(${t.owner})`, sql`lower(${t.name})`),
    index("repos_installation_id_idx").on(t.installationId),
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
}

/**
 * One analysis of one commit by one analyzer version. The unique key is the
 * cache key: a new analyzer version re-analyzes, the same one reuses.
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
  },
  (t) => [
    unique("analyses_repo_sha_version_key").on(t.repoId, t.sha, t.analyzerVersion),
    index("analyses_repo_created_idx").on(t.repoId, t.createdAt),
    check("analyses_sha_check", isSha(t.sha)),
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
 * Whether a user may view a private repo, as GitHub last answered. Valid for
 * 60 s from `checked_at` (ADR-0009); readers compare against their own clock.
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

/** The bot's record of one pull request: the diff it posted and where (M8). */
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
