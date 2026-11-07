import { headers } from "next/headers";
import { cache } from "react";
import { readSession } from "./authRoute";
import { authDepsFromEnv } from "./serverDeps";

/** What the site's chrome needs to know about sign-in, for one request (M8.2b). */
export interface SignInView {
  /** Whether sign-in is set up on this server; without it, nothing offers it. */
  available: boolean;
  /** The signed-in user's GitHub login, when the request carries a live session. */
  login?: string;
}

/**
 * The request's {@link SignInView}: read once per request (React's `cache`), so the header
 * and the page share one session lookup. A session that can't be read renders signed out
 * (`readSession`), never a broken page.
 */
export const currentSignIn = cache(async (): Promise<SignInView> => {
  const auth = authDepsFromEnv();
  if (auth === undefined) return { available: false };
  const user = await readSession((await headers()).get("cookie"), auth);
  return user === undefined ? { available: true } : { available: true, login: user.login };
});
