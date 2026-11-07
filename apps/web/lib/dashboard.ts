import { endUserSession, userAccessToken, type AuthDeps, type SignedInUser } from "./authRoute";
import { GITHUB_WEB, SignInError, TokenRefusedError } from "./githubOAuth";
import { listInstallations, type Installation } from "./installations";

/**
 * What the dashboard (`/dashboard`, M8.2c, ADR-0223) shows a signed-in user: their
 * installations of the app and the repos each covers, read from GitHub with their own token
 * on every visit (nothing is stored). `ended` means the session couldn't get a working token
 * and has been deleted; the page then sends the visitor to the landing page, signed out.
 */
export type DashboardView =
  | {
      kind: "ready";
      installations: Installation[];
      /** Installations GitHub says the user can see (more than listed past one page). */
      total: number;
      installUrl?: string;
    }
  | { kind: "error"; installUrl?: string }
  | { kind: "ended" };

/** GitHub's page for installing the app on more accounts or repos. */
export function installUrl(slug: string): string {
  return new URL(`/apps/${slug}/installations/new`, GITHUB_WEB).href;
}

/** GitHub's settings page for one installation, where its repos are chosen. */
export function installationSettingsUrl(installation: Installation): string {
  const path =
    installation.accountType === "Organization"
      ? `/organizations/${installation.account}/settings/installations/${installation.id}`
      : `/settings/installations/${installation.id}`;
  return new URL(path, GITHUB_WEB).href;
}

function log(event: string, error: unknown): void {
  const reason =
    error instanceof SignInError ? error.reason : error instanceof Error ? error.name : undefined;
  console.error(JSON.stringify({ event, ...(reason !== undefined && { error: reason }) }));
}

/** Read {@link DashboardView} for `user`. */
export async function loadDashboard(user: SignedInUser, deps: AuthDeps): Promise<DashboardView> {
  const install = deps.appSlug === undefined ? {} : { installUrl: installUrl(deps.appSlug) };
  const access = await userAccessToken(user, deps);
  if ("ended" in access) return { kind: "ended" };
  if ("error" in access) return { kind: "error", ...install };
  try {
    const { installations, total } = await listInstallations(deps.client, access.token);
    return { kind: "ready", installations, total, ...install };
  } catch (error) {
    if (error instanceof TokenRefusedError) {
      // Revoked on GitHub (the user removed the app's authorization): the session is over.
      const ended = await endUserSession(user, deps, "session_token_refused");
      return "ended" in ended ? { kind: "ended" } : { kind: "error", ...install };
    }
    log("dashboard_read_failed", error);
    return { kind: "error", ...install };
  }
}
