/**
 * Signed-in users and their sessions (M8.2, ADR-0221). The website decides what goes in:
 * a session is keyed by the SHA-256 of its cookie's token (never the token), and carries the
 * user's GitHub tokens already sealed. These functions only store and find rows, with every
 * time on the database's clock so serverless instances agree on when a session ends.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { AnyDatabase } from "./analyses.js";
import { sessions, users } from "./schema.js";

/** A GitHub account, as `GET /user` names it. */
export interface GitHubIdentity {
  githubUserId: number;
  login: string;
}

/**
 * Insert the user with this GitHub ID, or update its `login` (GitHub logins can be renamed;
 * the ID can't). Returns the row's ID.
 */
export async function upsertUser(db: AnyDatabase, identity: GitHubIdentity): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ githubUserId: identity.githubUserId, login: identity.login })
    .onConflictDoUpdate({ target: users.githubUserId, set: { login: identity.login } })
    .returning({ id: users.id });
  if (row === undefined) throw new Error("the user upsert returned no row");
  return row.id;
}

/** What {@link createSession} stores. */
export interface NewSession {
  userId: string;
  /** SHA-256 of the cookie's token, 64 lowercase hex characters. */
  tokenHash: string;
  /** The user's GitHub tokens, sealed by the caller. */
  githubTokens: string;
  /** How long the session lasts from now, in whole seconds (> 0). */
  lifetimeSeconds: number;
}

/** Store a new session; returns when it ends. */
export async function createSession(db: AnyDatabase, session: NewSession): Promise<Date> {
  const { lifetimeSeconds } = session;
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new RangeError("lifetimeSeconds must be a positive integer");
  }
  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: session.tokenHash,
      userId: session.userId,
      githubTokens: session.githubTokens,
      expiresAt: sql`now() + ${lifetimeSeconds} * interval '1 second'`,
    })
    .returning({ expiresAt: sessions.expiresAt });
  if (row === undefined) throw new Error("the session insert returned no row");
  return row.expiresAt;
}

/** A live session and its user, as {@link findSession} reads them. */
export interface FoundSession {
  sessionId: string;
  userId: string;
  githubUserId: number;
  login: string;
  githubTokens: string;
  expiresAt: Date;
}

/** The session whose token hashes to `tokenHash`, if it exists and hasn't ended. */
export async function findSession(
  db: AnyDatabase,
  tokenHash: string,
): Promise<FoundSession | undefined> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      githubUserId: users.githubUserId,
      login: users.login,
      githubTokens: sessions.githubTokens,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
  return row;
}

/** Delete the session whose token hashes to `tokenHash` (sign-out); a missing one is fine. */
export async function deleteSession(db: AnyDatabase, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
