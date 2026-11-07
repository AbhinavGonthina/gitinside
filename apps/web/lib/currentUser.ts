import { headers } from "next/headers";
import { cache } from "react";
import { readSession, type AuthDeps, type SignedInUser } from "./authRoute";
import { authDepsFromEnv } from "./serverDeps";

/** What the site's chrome needs to know about sign-in, for one request (M8.2b). */
export interface SignInView {
  /** Whether sign-in is set up on this server; without it, nothing offers it. */
  available: boolean;
  /** The signed-in user's GitHub login, when the request carries a live session. */
  login?: string;
}

/**
 * Sign-in's deps and the request's signed-in user, read once per request (React's `cache`),
 * so the header and the page share one session lookup. `auth` is `undefined` when sign-in
 * isn't set up; `user` when the request carries no live session, or it can't be read
 * (`readSession`: a page then renders signed out, never broken).
 */
export const currentUser = cache(async (): Promise<{ auth?: AuthDeps; user?: SignedInUser }> => {
  const auth = authDepsFromEnv();
  if (auth === undefined) return {};
  const user = await readSession((await headers()).get("cookie"), auth);
  return user === undefined ? { auth } : { auth, user };
});

/** The request's {@link SignInView}, from {@link currentUser}. */
export const currentSignIn = cache(async (): Promise<SignInView> => {
  const { auth, user } = await currentUser();
  if (auth === undefined) return { available: false };
  return user === undefined ? { available: true } : { available: true, login: user.login };
});
