/**
 * GitHub App installations as their webhooks describe them (M8.3a, ADR-0224). The website
 * checks each delivery's signature and shape; these functions only store what it read, and
 * delete an installation's private data when it's uninstalled or loses repos (M8.5a,
 * {@link deleteInstallationData}).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { PRIVATE_SNAPSHOT_PREFIX, type AnyDatabase } from "./analyses.js";
import { accessCache, analyses, installations, pullRequests, repos } from "./schema.js";

/** One installation, as an `installation` or `installation_repositories` event carries it. */
export interface InstallationFacts {
  githubInstallationId: number;
  /** GitHub's ID for the account it's installed on (survives renames). */
  accountId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  /** When the account suspended the app, or `null` while it isn't suspended. */
  suspendedAt: Date | null;
}

/** An installation's row, as {@link findInstallation} reads it. */
export interface InstallationRow extends InstallationFacts {
  id: string;
}

/**
 * Insert the installation, or bring its account and suspension up to date. Returns the
 * row's ID. A delivery that arrives twice writes the same values twice.
 */
export async function upsertInstallation(
  db: AnyDatabase,
  facts: InstallationFacts,
): Promise<string> {
  const values = {
    accountId: facts.accountId,
    accountLogin: facts.accountLogin,
    accountType: facts.accountType,
    suspendedAt: facts.suspendedAt,
  };
  const [row] = await db
    .insert(installations)
    .values({ githubInstallationId: facts.githubInstallationId, ...values })
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning({ id: installations.id });
  if (row === undefined) throw new Error("the installation upsert returned no row");
  return row.id;
}

/** The installation with GitHub's ID `githubInstallationId`, if one is stored. */
export async function findInstallation(
  db: AnyDatabase,
  githubInstallationId: number,
): Promise<InstallationRow | undefined> {
  const [row] = await db
    .select({
      id: installations.id,
      githubInstallationId: installations.githubInstallationId,
      accountId: installations.accountId,
      accountLogin: installations.accountLogin,
      accountType: installations.accountType,
      suspendedAt: installations.suspendedAt,
    })
    .from(installations)
    .where(eq(installations.githubInstallationId, githubInstallationId));
  if (row === undefined) return undefined;
  const { accountType } = row;
  if (accountType !== "User" && accountType !== "Organization") {
    throw new Error("an installation row with an unknown account type");
  }
  return { ...row, accountType };
}

/**
 * Link the stored repos among `providerRepoIds` (GitHub's repo IDs) to the installation with
 * GitHub's ID `githubInstallationId`, moving any linked elsewhere (a transferred repo). Repos
 * not stored yet are linked when they're first analyzed. Returns how many rows changed.
 * Throws if the installation isn't stored: an unknown installation must never unlink repos.
 */
export async function linkInstallationRepos(
  db: AnyDatabase,
  githubInstallationId: number,
  providerRepoIds: readonly number[],
): Promise<number> {
  const installation = await findInstallation(db, githubInstallationId);
  if (installation === undefined) throw new Error("link repos to an unknown installation");
  let count = 0;
  // In chunks: Postgres takes at most 65,535 parameters per statement.
  for (let i = 0; i < providerRepoIds.length; i += LINK_CHUNK) {
    const linked = await db
      .update(repos)
      .set({ installationId: installation.id, updatedAt: sql`now()` })
      .where(inArray(repos.providerRepoId, providerRepoIds.slice(i, i + LINK_CHUNK)))
      .returning({ id: repos.id });
    count += linked.length;
  }
  return count;
}

/** Repo IDs per statement in {@link linkInstallationRepos} and {@link deleteInstallationData}. */
export const LINK_CHUNK = 1_000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += LINK_CHUNK) out.push(items.slice(i, i + LINK_CHUNK));
  return out;
}

/** The bucket prefix of every snapshot a job through installation `githubInstallationId` stored. */
export function installationSnapshotPrefix(githubInstallationId: number): string {
  if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId < 1) {
    throw new Error("githubInstallationId must be a positive integer");
  }
  return `${PRIVATE_SNAPSHOT_PREFIX}${githubInstallationId}/`;
}

/** What {@link deleteInstallationData} deleted, and where the matching objects are. */
export interface InstallationDeletion {
  /** Private repos deleted with everything that hangs off them. */
  deletedRepos: number;
  /** Repos kept but unlinked (public ones linked to the installation). */
  unlinkedRepos: number;
  /** Whether the installation's own row was deleted (`all` only, when it was stored). */
  installationDeleted: boolean;
  /**
   * Bucket prefixes whose objects the deleted rows named, for the caller to list and delete:
   * the installation's `private/<id>/` for `all`, else `private/<id>/<repo row ID>/` per repo
   * named. Sorted. No row names an object under them any more, so retention's orphan sweep
   * removes whatever the caller fails to delete.
   */
  prefixes: string[];
}

/**
 * Delete what an installation's uninstall (`scope` `"all"`, GitHub's `installation`
 * `deleted`) or its loss of repos (GitHub's repo IDs, `installation_repositories` `removed`)
 * leaves us no right to keep (SPEC §3, SECURITY.md T7, ADR-0240), in one transaction:
 *
 * - a **private repo linked to the installation** is deleted with its analyses, PR records,
 *   and access-cache rows (the foreign keys cascade);
 * - **every other repo concerned** (linked to it, named in the list, or with an analysis
 *   stored under its prefix) loses the analyses stored under `private/<id>/`; a public repo
 *   linked to it is also unlinked, losing its PR records and access-cache rows. Its public
 *   analyses stay: anyone can make them again from the public repo (ADR-0239);
 * - for `"all"`, the installation's row.
 *
 * The installation's row is locked first, so a job start linking a repo to it
 * (`upsertRepo`) either finishes before and is deleted here, or starts after and finds the
 * row gone. Running it twice deletes nothing the second time; an installation never stored
 * still has its prefix's analyses deleted.
 */
export async function deleteInstallationData(
  db: AnyDatabase,
  githubInstallationId: number,
  scope: "all" | readonly number[],
): Promise<InstallationDeletion> {
  const root = installationSnapshotPrefix(githubInstallationId);
  const storedHere = sql`left(${analyses.snapshotKey}, ${root.length}) = ${root}`;
  return db.transaction(async (tx) => {
    const [installation] = await tx
      .select({ id: installations.id })
      .from(installations)
      .where(eq(installations.githubInstallationId, githubInstallationId))
      .for("update");
    const here = installation?.id;
    const columns = {
      id: repos.id,
      visibility: repos.visibility,
      installationId: repos.installationId,
    };
    const targets: { id: string; visibility: string; installationId: string | null }[] = [];
    if (scope === "all") {
      const withSnapshots = tx
        .selectDistinct({ id: analyses.repoId })
        .from(analyses)
        .where(storedHere);
      const linked = here === undefined ? sql`false` : eq(repos.installationId, here);
      targets.push(
        ...(await tx
          .select(columns)
          .from(repos)
          .where(or(linked, inArray(repos.id, withSnapshots)))),
      );
    } else {
      for (const ids of chunks(scope)) {
        targets.push(
          ...(await tx.select(columns).from(repos).where(inArray(repos.providerRepoId, ids))),
        );
      }
    }

    const linkedHere = (repo: (typeof targets)[number]) =>
      here !== undefined && repo.installationId === here;
    const drop = targets
      .filter((r) => r.visibility === "private" && linkedHere(r))
      .map((r) => r.id);
    const dropped = new Set(drop);
    const kept = targets.filter((r) => !dropped.has(r.id));
    const unlink = kept.filter(linkedHere).map((r) => r.id);
    for (const ids of chunks(kept.map((r) => r.id))) {
      await tx.delete(analyses).where(and(inArray(analyses.repoId, ids), storedHere));
    }
    for (const ids of chunks(unlink)) {
      await tx.delete(pullRequests).where(inArray(pullRequests.repoId, ids));
      await tx.delete(accessCache).where(inArray(accessCache.repoId, ids));
      await tx
        .update(repos)
        .set({ installationId: null, updatedAt: sql`now()` })
        .where(inArray(repos.id, ids));
    }
    for (const ids of chunks(drop)) await tx.delete(repos).where(inArray(repos.id, ids));
    let installationDeleted = false;
    if (scope === "all" && here !== undefined) {
      await tx.delete(installations).where(eq(installations.id, here));
      installationDeleted = true;
    }
    const prefixes =
      scope === "all" ? [root] : [...new Set(targets.map((r) => `${root}${r.id}/`))].sort();
    return {
      deletedRepos: drop.length,
      unlinkedRepos: unlink.length,
      installationDeleted,
      prefixes,
    };
  });
}
