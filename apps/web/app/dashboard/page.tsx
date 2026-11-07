import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "../../lib/currentUser";
import { loadDashboard } from "../../lib/dashboard";
import { SIGN_IN_HREF } from "../SiteHeader";
import { Dashboard } from "./Dashboard";

export const metadata: Metadata = {
  title: "Your repos",
  robots: { index: false, follow: false },
};

/** Where a signed-out visitor goes: sign in, then back here. */
const DASHBOARD_SIGN_IN = `${SIGN_IN_HREF}?returnTo=${encodeURIComponent("/dashboard")}`;

/**
 * The signed-in dashboard (M8.2c, ADR-0223): the user's installations of the app and their
 * repos, read from GitHub with the user's token on each visit. Signed out, it starts sign-in
 * and comes back; with sign-in not set up, the landing page says so. A session whose GitHub
 * token no longer works has been ended by `loadDashboard`, and lands signed out with a note.
 */
export default async function DashboardPage() {
  const { auth, user } = await currentUser();
  if (auth === undefined) redirect("/?signin=unavailable");
  if (user === undefined) redirect(DASHBOARD_SIGN_IN);
  const view = await loadDashboard(user, auth);
  if (view.kind === "ended") redirect("/?signin=ended");
  return <Dashboard view={view} />;
}
