import type { Metadata } from "next";
import Link from "next/link";
import { repoFile } from "../../lib/docs";
import { ANALYSIS_TIME_LIMIT } from "../../lib/limits";
import { DocsPage, DocsSection } from "../_docs/DocsPage";

export const metadata: Metadata = {
  title: "Limits",
  description:
    "How big a repo GitInside analyzes, how often you can start an analysis, and how long diagrams are kept.",
};

/**
 * Every limit a visitor can meet (M9.4a). The numbers are written out for reading, and
 * `docs.test.tsx` checks each against the constant that sets it, so changing a limit
 * without this page fails CI (as `abuseLimits.test.ts` does for docs/SECURITY.md's T9).
 */
export default function Limits() {
  return (
    <DocsPage
      current="/limits"
      lede="GitInside runs on free plans, so every analysis has limits. Here is each one, and what happens when a repo or a visitor meets it."
    >
      <DocsSection id="size" title="Repo size">
        <ul className="docs__list">
          <li>
            Up to <strong>20,000 source files</strong> and <strong>50 MB of source code</strong>.
            Source means <code>.ts .tsx .mts .cts .js .jsx .mjs .cjs .prisma</code> files, leaving
            out ignored, generated, and minified ones. A bigger repo fails in seconds, before any
            parsing.
          </li>
          <li>
            A single file over <strong>2 MB</strong> is skipped with a warning, and so is anything
            in a folder nested more than <strong>64</strong> deep.
          </li>
          <li>
            A repo with over <strong>100 MB</strong> of TypeScript and JavaScript by GitHub&apos;s
            own count is refused before it&apos;s downloaded.
          </li>
          <li>
            Unpacked, the download may hold up to <strong>400 MB</strong> and{" "}
            <strong>60,000 files and folders</strong>.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="time" title="Time and memory">
        <p>
          Each analysis runs on 1 CPU with 4 GB of memory, and is always given at least{" "}
          <strong>{ANALYSIS_TIME_LIMIT}</strong> and up to <strong>2,560 MB</strong> of memory for
          the analyzer itself. A repo of many services can run out of either under the size limits.
        </p>
        <p>
          A repo that fails on a size, time, or memory limit isn&apos;t tried again for{" "}
          <strong>7 days</strong>, unless the repo shrinks to half its size on GitHub.
        </p>
      </DocsSection>

      <DocsSection id="rate" title="How often">
        <p>
          Opening a finished diagram, a README image, or a job that&apos;s already running is never
          limited. Only a new analysis counts:
        </p>
        <ul className="docs__list">
          <li>
            Signed out: <strong>5 new analyses an hour</strong> from one address (IPv6 counts per
            /64).
          </li>
          <li>
            Signed in: <strong>30 an hour</strong>, whatever address you&apos;re on.
          </li>
          <li>
            Each repo: <strong>1 new analysis every 30 minutes</strong>, whoever asks. Views of its
            page and README images analyze at most <strong>6 new commits an hour</strong>.
          </li>
          <li>
            Signed out, the <strong>3rd</strong> new analysis in an hour from one address asks for
            Cloudflare Turnstile&apos;s bot check. After <strong>20</strong> requests for new
            analyses in an hour across the whole site, everyone gets it.
          </li>
        </ul>
        <p>Hours are clock hours in UTC. A refusal says why, and when to try again.</p>
      </DocsSection>

      <DocsSection id="month" title="Each month">
        <p>
          New analyses pause once <strong>80%</strong> of the month&apos;s free compute is used,
          until the next month starts (UTC). Diagrams already made keep working.
        </p>
      </DocsSection>

      <DocsSection id="kept" title="How long diagrams are kept">
        <ul className="docs__list">
          <li>
            For each public repo, the diagrams of its latest <strong>5</strong> analyzed commits.
            Older ones are deleted.
          </li>
          <li>
            Also kept: any commit named by a pull request updated in the last{" "}
            <strong>30 days</strong>, and the three demo repos on the home page.
          </li>
          <li>
            A private repo&apos;s diagrams are deleted as soon as the GitHub App is uninstalled or
            the repo is removed from it (see <Link href="/privacy">Privacy</Link>).
          </li>
          <li>
            If storage still runs past <strong>16 GB</strong>, the oldest diagrams go first.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="more" title="More detail">
        <p>
          The abuse limits, with what each one bounds, are in{" "}
          <a href={repoFile("docs/SECURITY.md")}>SECURITY.md</a>. What the analyzer can and
          can&apos;t read is on <Link href="/how-it-works#coverage">How it works</Link>.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
