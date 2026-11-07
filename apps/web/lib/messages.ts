/**
 * Words shared by the server and the browser, in a module with no imports so client
 * components can use them without pulling in the database code.
 */

/** UX.md's words for the worker being down. */
export const UNAVAILABLE_MESSAGE =
  "Analysis is temporarily unavailable. Already-analyzed repos still work.";

/**
 * UX.md's words for where a failed sign-in or sign-out lands (`/?signin=<reason>`,
 * `/?signout=failed`, authRoute.ts). Anything else in those parameters says nothing.
 */
export const SIGN_IN_NOTES: Readonly<Record<string, string>> = {
  cancelled: "Sign-in was cancelled on GitHub. Nothing changed.",
  expired: "Sign-in took too long, so it was stopped. Try again.",
  failed: "Sign-in didn't work. Try again.",
  unavailable: "Sign-in isn't available right now. Public repos still work without it.",
  ended: "Your GitHub sign-in ended, so you've been signed out. Sign in again to see your repos.",
};

/** UX.md's words for a sign-out the server couldn't finish. */
export const SIGN_OUT_FAILED_NOTE = "We couldn't sign you out. Try again.";

/**
 * UX.md's words for where GitHub's install return lands (`/dashboard?install=<outcome>`,
 * authRoute.ts, M8.3b). `installed` and `updated` name the account when the dashboard lists
 * the installation; anything else in the parameter says nothing.
 */
export function installNote(
  outcome: string | string[] | undefined,
  account: string | undefined,
): string | undefined {
  const on = account === undefined ? "" : ` on ${account}`;
  switch (outcome) {
    case "installed":
      return `GitInside is installed${on}.`;
    case "updated":
      return `Your changes to GitInside${on} are saved.`;
    case "requested":
      return "Your request to install GitInside was sent to the organization's owners. Its repos show here once they approve it.";
    case "unverified":
      return "GitHub doesn't list that installation for your account, so nothing changed. Sign in with the GitHub account that installed GitInside.";
    case "failed":
      return "We couldn't confirm the installation with GitHub. If it's missing below, reload in a moment.";
    default:
      return undefined;
  }
}

/** The note for a landing page's query, if it names a known outcome. */
export function signInNote(query: {
  signin?: string | string[] | undefined;
  signout?: string | string[] | undefined;
}): string | undefined {
  const { signin, signout } = query;
  if (signout === "failed") return SIGN_OUT_FAILED_NOTE;
  return typeof signin === "string" && Object.hasOwn(SIGN_IN_NOTES, signin)
    ? SIGN_IN_NOTES[signin]
    : undefined;
}
