import { currentSignIn } from "../lib/currentUser";
import { signInNote } from "../lib/messages";
import { Landing } from "./Landing";

type Query = Record<string, string | string[] | undefined>;

/**
 * The landing page (UX.md "Website flows"). `?signin=<reason>` and `?signout=failed` are
 * where a failed sign-in or sign-out lands (authRoute.ts); the page explains them.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Query> }) {
  const [signIn, query] = await Promise.all([currentSignIn(), searchParams]);
  return <Landing signIn={signIn} note={signInNote(query)} />;
}
