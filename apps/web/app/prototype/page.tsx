import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { currentSignIn } from "../../lib/currentUser";
import { prototypeGraphUrl, prototypeRepoParam } from "../../lib/prototype";
import { parseTheme, THEME_COOKIE } from "../../lib/theme";
import { SiteAccount } from "../SiteHeader";
import { ThemeSwitch } from "../ThemeSwitch";
import { PrototypeDiagram } from "./PrototypeDiagram";
import { PrototypeLanding } from "./PrototypeLanding";

/** Never indexed: the page is for the design gate's review only. */
export const metadata: Metadata = {
  title: "Design prototype",
  robots: { index: false, follow: false },
};

/**
 * The M10 design prototype (M10.3, lib/prototype.ts): with no `repo`, the redesigned landing page
 * (M10.3e1), which ends with a list of the five repos it draws; with `?repo=<owner>/<name>` of one
 * of them, that repo's diagram in the redesign, under
 * one bar for the whole page (M10-design A7): the site header's theme switch and sign-in move
 * into the explorer's bar. Any other `repo` is a 404. One path segment, so it never shadows a
 * GitHub owner's repo pages (`/<owner>/<repo>`), and nothing on the site links here.
 */
export default async function PrototypePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = (await searchParams) ?? {};
  const signIn = await currentSignIn();
  if (query.repo === undefined) return <PrototypeLanding signIn={signIn} />;
  const repo = prototypeRepoParam(query.repo);
  if (repo === undefined) notFound();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <PrototypeDiagram
      owner={repo.owner}
      repo={repo.name}
      sha={repo.sha}
      graphUrl={prototypeGraphUrl(repo)}
      barEnd={
        <>
          <ThemeSwitch compact initial={theme} />
          <SiteAccount signIn={signIn} />
        </>
      }
    />
  );
}
