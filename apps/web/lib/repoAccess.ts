import { findAccess, recordAccess } from "@gitinside/db";
import { endUserSession, userAccessToken, type AuthDeps, type SignedInUser } from "./authRoute";
import { apiHeaders, field, githubUrl, SignInError, type OAuthClient } from "./githubOAuth";

/**
 * The per-view access check for private repos (SPEC §3, ADR-0009, ADR-0231): may this
 * signed-in user see this stored repo right now? GitHub decides, asked with the user's own
 * token: `GET /repositories/{id}` answers a user-to-server token only for a repo the app is
 * installed on *and* the user can read, so a 200 is both checks at once. Asking by GitHub's ID
 * rather than the name means a rename can't point the check at another repo.
 *
 * - **Cached for 60 s per user and repo** (`findAccess`/`recordAccess`, the database's clock),
 *   grants and refusals alike: access removed on GitHub is refused within a minute, access
 *   given is seen within a minute.
 * - **Fails closed:** anything but a clear answer (a timeout, a 5xx, a rate limit, an answer
 *   out of shape or for another repo, the cache unreadable) is `error`, never `allowed`, and
 *   isn't cached, so the next view asks again.
 * - **401 ends the session**, as on the dashboard (ADR-0223): the user revoked the app.
 *
 * Handled: GitHub's 404 (no access, not installed, or deleted) and a 403 that isn't a rate
 * limit (an organization's SAML or IP allow list) as refusals. Not handled here: what a page or
 * route shows for each answer (M8.4b, M8.4c), and whether the repo is still private (a public
 * repo is readable with any token, so it's simply allowed).
 */

/** What {@link checkRepoAccess} found. */
export type RepoAccess = { allowed: boolean } | { ended: true } | { error: true };

/** The stored repo being viewed: our row ID and GitHub's ID. */
export interface AccessRepo {
  id: string;
  providerRepoId: number;
}

/** How long the call to GitHub may take before the check gives up (and the view with it). */
const TIMEOUT_MS = 10_000;

function log(event: string, error: unknown): void {
  const reason =
    error instanceof SignInError ? error.reason : error instanceof Error ? error.name : "unknown";
  console.error(JSON.stringify({ event, error: reason }));
}

/** Whether a 403 is GitHub's rate limit (primary or secondary) rather than a refusal. */
function rateLimited(response: Response): boolean {
  return (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
  );
}

/**
 * GitHub's answer for `providerRepoId` with the user's token: `true` shown, `false` refused,
 * `"token-refused"` on a 401. Throws {@link SignInError} for anything else.
 */
async function askGitHub(
  client: OAuthClient,
  accessToken: string,
  providerRepoId: number,
): Promise<boolean | "token-refused"> {
  const response = await (client.fetch ?? fetch)(
    githubUrl(client, "api", `/repositories/${providerRepoId}`),
    {
      headers: apiHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (response.status === 401) return "token-refused";
  if (response.status === 404) return false;
  if (response.status === 403 && !rateLimited(response)) return false;
  if (response.status !== 200) throw new SignInError(`HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SignInError("not JSON");
  }
  if (field(body, "id") !== providerRepoId) throw new SignInError("answer for another repo");
  return true;
}

/** Whether `user` may view `repo` now (see the module's notes). */
export async function checkRepoAccess(
  user: SignedInUser,
  repo: AccessRepo,
  deps: AuthDeps,
): Promise<RepoAccess> {
  try {
    const cached = await findAccess(deps.db, user.userId, repo.id);
    if (cached !== undefined) return { allowed: cached };
  } catch (error) {
    log("repo_access_failed", error);
    return { error: true };
  }

  const access = await userAccessToken(user, deps);
  if (!("token" in access)) return access;
  let allowed: boolean | "token-refused";
  try {
    allowed = await askGitHub(deps.client, access.token, repo.providerRepoId);
  } catch (error) {
    log("repo_access_failed", error);
    return { error: true };
  }
  if (allowed === "token-refused") {
    // Revoked on GitHub (the user removed the app's authorization): the session is over.
    const ended = await endUserSession(user, deps, "session_token_refused");
    return "ended" in ended ? ended : { error: true };
  }

  try {
    await recordAccess(deps.db, user.userId, repo.id, allowed);
  } catch (error) {
    // GitHub's answer stands for this view; the next one asks again.
    log("repo_access_record_failed", error);
  }
  return { allowed };
}
