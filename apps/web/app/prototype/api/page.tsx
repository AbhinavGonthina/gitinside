import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { currentSignIn } from "../../../lib/currentUser";
import { prototypeGraphUrl, prototypeRepoParam } from "../../../lib/prototype";
import { parseApiQuery } from "../../../lib/prototypeApiMap";
import { parseTheme, THEME_COOKIE } from "../../../lib/theme";
import { SiteAccount } from "../../SiteHeader";
import { ThemeSwitch } from "../../ThemeSwitch";
import "../transitions.css";
import "./apiMap.css";
import { PrototypeApiMap } from "./PrototypeApiMap";

/** Never indexed: the page is for the design gate's review only. */
export const metadata: Metadata = {
  title: "API map · Design prototype",
  robots: { index: false, follow: false },
};

/**
 * The M10 prototype's API map (M10-design §3.3, M10.3f3) at `/prototype/api?repo=<owner>/<name>`,
 * for the five prototype repos only (any other `repo` is a 404), over the same proxied graph as
 * their diagrams. The tab, search, and filters come from the URL.
 */
export default async function PrototypeApiPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (await searchParams) ?? {};
  const repo = prototypeRepoParam(query.repo);
  if (repo === undefined) notFound();
  const signIn = await currentSignIn();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <PrototypeApiMap
      repo={repo}
      graphUrl={prototypeGraphUrl(repo)}
      initial={parseApiQuery(query)}
      barEnd={
        <>
          <ThemeSwitch compact initial={theme} />
          <SiteAccount signIn={signIn} />
        </>
      }
    />
  );
}
