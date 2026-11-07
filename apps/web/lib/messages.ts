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
};

/** UX.md's words for a sign-out the server couldn't finish. */
export const SIGN_OUT_FAILED_NOTE = "We couldn't sign you out. Try again.";

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
