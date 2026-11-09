import { DeletedInstallationError, upsertInstallation } from "@gitinside/db";
import { endUserSession, userAccessToken, type AuthDeps, type SignedInUser } from "./authRoute";
import type { QueueRepo } from "./enqueue";
import { resolveSeenRepo, type GitHubOptions, type ResolveFailure } from "./github";
import { githubUrl, SignInError, TokenRefusedError, type OAuthClient } from "./githubOAuth";
import { findAccountInstallation } from "./installations";
import type { RepoRef } from "./repoUrl";

/**
 * A private repo as a signed-in user's "Analyze" finds it (M8.4c2b, ADR-0235): asked by name
 * with the user's own token, which GitHub shows a private repo only where the app is installed
 * *and* the user can read it, so one answer is both checks. The installation it's read through
 * is the user's installation on the repo's account (`GET /user/installations`), stored from
 * GitHub's answer as the install return stores it (ADR-0225), so a lost webhook doesn't refuse
 * it.
 *
 * Anything that isn't such a repo is `REPO_NOT_FOUND`, exactly as the public lookup said: a
 * repo the user can't see, one GitHub shows as public (the public lookup just said otherwise),
 * no installation on its account (or one uninstalled since GitHub answered, M8.10e2a), or a
 * session that has ended. GitHub or the database failing
 * is `GITHUB_UNAVAILABLE`.
 */

/** What {@link resolvePrivateRepo} found: the repo to queue, and how to read GitHub for it. */
export type PrivateResult =
  | { ok: true; repo: QueueRepo & { visibility: "private" }; github: GitHubOptions }
  | { ok: false; code: ResolveFailure };

/**
 * `base` with the user's `token`, on the API the sign-in client uses (the E2E's fake in tests):
 * for reading a private repo the user can see.
 */
export function userGitHub(token: string, client: OAuthClient, base: GitHubOptions): GitHubOptions {
  return {
    ...base,
    token,
    apiBase: githubUrl(client, "api", "/"),
    ...(client.fetch === undefined ? {} : { fetch: client.fetch }),
  };
}

const NOT_FOUND = { ok: false, code: "REPO_NOT_FOUND" } as const;
const UNAVAILABLE = { ok: false, code: "GITHUB_UNAVAILABLE" } as const;

function log(event: string, error: unknown): void {
  const reason =
    error instanceof SignInError ? error.reason : error instanceof Error ? error.name : "unknown";
  console.error(JSON.stringify({ event, error: reason }));
}

/** The private repo `ref` names as `user` sees it on GitHub, with its installation. */
export async function resolvePrivateRepo(
  ref: RepoRef,
  user: SignedInUser,
  auth: AuthDeps,
  base: GitHubOptions = {},
): Promise<PrivateResult> {
  const access = await userAccessToken(user, auth);
  if ("ended" in access) return NOT_FOUND;
  if ("error" in access) return UNAVAILABLE;
  const github = userGitHub(access.token, auth.client, base);
  const seen = await resolveSeenRepo(ref, github);
  if (!seen.ok) return seen;
  if (seen.repo.visibility !== "private") return NOT_FOUND;
  try {
    const installation = await findAccountInstallation(auth.client, access.token, seen.repo.owner);
    if (installation === undefined) return NOT_FOUND;
    await upsertInstallation(auth.db, installation);
    const installationId = installation.githubInstallationId;
    return { ok: true, repo: { ...seen.repo, visibility: "private", installationId }, github };
  } catch (error) {
    // Uninstalled since GitHub answered (M8.10e2a): nothing stored, as for no installation.
    if (error instanceof DeletedInstallationError) return NOT_FOUND;
    if (error instanceof TokenRefusedError) {
      // Revoked on GitHub (the user removed the app's authorization): the session is over.
      const ended = await endUserSession(user, auth, "session_token_refused");
      return "ended" in ended ? NOT_FOUND : UNAVAILABLE;
    }
    log("private_repo_failed", error);
    return UNAVAILABLE;
  }
}
