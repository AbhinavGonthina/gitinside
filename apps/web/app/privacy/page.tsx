import type { Metadata } from "next";
import Link from "next/link";
import { repoFile } from "../../lib/docs";
import { DocsPage, DocsSection } from "../_docs/DocsPage";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What GitInside stores about a repo and about you, the cookies it sets, and what happens when you uninstall it.",
};

/** Every cookie the site sets, what it's for, and how long it's kept. */
const COOKIES = [
  {
    name: "gi-theme",
    purpose: "Dark or light, so the page opens in the theme you picked.",
    kept: "for 1 year",
  },
  {
    name: "__Host-gi_session",
    purpose: "Keeps you signed in. Scripts on the page can't read it.",
    kept: "for up to 30 days",
  },
  {
    name: "__Host-gi_signin",
    purpose: "Checks that a sign-in coming back from GitHub is the one you started.",
    kept: "for 10 minutes",
  },
] as const;

/**
 * What GitInside keeps and shows (M9.4a). The cookie names and lifetimes are checked against
 * `session.ts` and `theme.ts` by `docs.test.tsx`; the rest follows docs/SECURITY.md (T5–T8,
 * T14).
 */
export default function Privacy() {
  return (
    <DocsPage
      current="/privacy"
      lede="GitInside keeps as little as it can: the diagram, never your code. It has no ads, no analytics, and no third-party trackers."
    >
      <DocsSection id="repos" title="What's stored about a repo">
        <p>
          For each analyzed commit, GitInside stores its diagram: the file paths, the names of
          functions, routes, and database models and fields, line numbers, and a hash of each file.
          It doesn&apos;t keep the code. The download is unpacked into the job&apos;s own temporary
          folder and deleted once the analysis ends.
        </p>
        <p>
          To make the next commit faster, the worker also keeps what the analysis found in each
          package (the same kind of names, paths, line numbers, and file hashes the diagram holds),
          in a cache in the worker&apos;s memory. It lasts only as long as that worker instance,
          within a fixed size. A repo installed through the GitHub App gets its own cache folder,
          which no other repo&apos;s analysis can read. Once the repo is no longer installed, the
          folder is deleted when that instance starts its next job, or when the instance stops.
        </p>
        <p>
          From <code>.env</code> files it keeps the variable names and the hosts of URLs, never the
          values. The database also records each repo&apos;s owner, name, visibility, and default
          branch, and each analysis&apos;s state.
        </p>
        <p>
          When you open a file in the diagram, your browser reads a public repo&apos;s code straight
          from GitHub, at that commit. A private repo&apos;s code comes through GitInside, read from
          GitHub with your own sign-in, and is never stored or cached.
        </p>
      </DocsSection>

      <DocsSection id="you" title="What's stored about you">
        <p>
          Nothing, unless you sign in. Signing in with GitHub asks for no permissions: GitInside
          reads only who you are. It stores your GitHub user ID and login, a hash of your session
          cookie, and your GitHub sign-in tokens, encrypted. Signing out deletes the session.
        </p>
        <p>
          To count new analyses per hour (see <Link href="/limits#rate">Limits</Link>), the site
          stores a keyed hash of your address, never the address itself, and deletes it within about
          three hours. Signed in, it counts by your account instead.
        </p>
      </DocsSection>

      <DocsSection id="private-repos" title="Private repos">
        <p>
          Private repos come through the GitHub App, which you install on the repos you choose. It
          asks GitHub for read access to code and metadata, and write access only to pull request
          comments and checks.
        </p>
        <ul className="docs__list">
          <li>
            A private repo&apos;s diagram is shown only to people GitHub says can see the repo,
            checked again at least every 60 seconds. Anyone else gets the same page as for a repo
            that was never analyzed.
          </li>
          <li>
            Its pages are never cached by the CDN or listed by search engines, and its README image
            is only ever a link-only badge.
          </li>
          <li>
            Uninstalling the App, or removing a repo from it, deletes that repo&apos;s private
            diagrams and records at once (a stored file whose deletion fails is swept within about
            two hours). Only GitHub&apos;s numeric IDs are kept, so a late message from GitHub
            can&apos;t add them back.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="cookies" title="Cookies">
        {/* A list, not a table: a cookie's name can't wrap, so a phone would squeeze a table's
            other columns to a word a line. */}
        <dl className="docs__terms" aria-label="Cookies">
          {COOKIES.map(({ name, purpose, kept }) => (
            <div key={name} className="docs__term">
              <dt>
                <code>{name}</code>
              </dt>
              <dd>
                {purpose} <span className="docs__kept">Kept {kept}.</span>
              </dd>
            </div>
          ))}
        </dl>
        <p>The last two are set only when you sign in.</p>
      </DocsSection>

      <DocsSection id="bot-check" title="The bot check">
        <p>
          When traffic looks automated, Analyze asks for Cloudflare Turnstile&apos;s check.
          Cloudflare&apos;s widget loads only then, and Cloudflare&apos;s own privacy policy covers
          it. GitInside sends Cloudflare the widget&apos;s answer, not your address.
        </p>
      </DocsSection>

      <DocsSection id="logs" title="Logs and hosts">
        <p>
          GitInside&apos;s own logs hold codes, IDs, counts, and timings: never a repo&apos;s code,
          and never your tokens. The site runs on Vercel (the website), Google Cloud Run (the
          analysis), Neon (the database), and Oracle Object Storage (the diagrams). Each sees the
          requests it serves, under its own policies.
        </p>
        <p>
          The <a href={repoFile("docs/SECURITY.md")}>threat model</a> covers each of these in
          detail, with the tests that check them. To report a vulnerability, see the{" "}
          <a href={repoFile("SECURITY.md")}>security policy</a>.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
