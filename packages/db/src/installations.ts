/**
 * GitHub App installations as their webhooks describe them (M8.3a, ADR-0224). The website
 * checks each delivery's signature and shape; these functions only store what it read.
 * Deleting an installation and its repos' private data is M8.5's.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { installations, repos } from "./schema.js";

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

/** Repo IDs per statement in {@link linkInstallationRepos}. */
export const LINK_CHUNK = 1_000;
