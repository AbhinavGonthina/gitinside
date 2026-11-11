import type { Metadata } from "next";
import Link from "next/link";
import { repoFile } from "../../lib/docs";
import { DocsPage, DocsSection } from "../_docs/DocsPage";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How GitInside turns a repo into a diagram: parsed with the TypeScript compiler, never run, the same diagram for the same commit.",
};

/** How an analysis runs, and what the diagram can and can't promise (M9.4a). */
export default function HowItWorks() {
  return (
    <DocsPage
      current="/how-it-works"
      lede="GitInside reads a repo's code the way a compiler does and draws what it finds. Nothing from the repo is installed or run, and no AI writes any part of the diagram."
    >
      <DocsSection id="stages" title="From a URL to a diagram">
        <p>
          When you paste a repo, the website records a job for its latest commit and queues it. The
          progress page then follows the job through its stages:
        </p>
        <ol className="docs__steps">
          <li>
            <strong>In the queue.</strong> The job waits for a free worker. Two run at once.
          </li>
          <li>
            <strong>Downloading.</strong> The worker downloads that commit&apos;s archive from
            GitHub.
          </li>
          <li>
            <strong>Unpacking.</strong> GitInside&apos;s own extractor writes only plain files and
            folders. Links are skipped, and a path that would land outside the job&apos;s folder
            fails the job.
          </li>
          <li>
            <strong>Analyzing.</strong> The analyzer finds the workspace&apos;s packages, parses
            every file with the TypeScript compiler, and reads the Express and Next.js routes, the
            Prisma models, docker-compose and <code>.env</code> files, functions and the calls
            between them, HTTP requests, SDK calls, and queues.
          </li>
          <li>
            <strong>Saving the diagram.</strong> The result is one graph file, which is stored. The
            downloaded code is deleted.
          </li>
        </ol>
        <p>
          A commit is analyzed once. After that its diagram opens at once, for anyone who can see
          the repo.
        </p>
      </DocsSection>

      <DocsSection id="never-run" title="Parsed, never run">
        <p>
          A repo you analyze could contain anything, so GitInside never runs it. It doesn&apos;t
          install packages, run scripts, or load the repo&apos;s config files. It reads their text.
        </p>
        <p>
          The analysis itself runs in a separate process locked down by Node&apos;s permission
          model. It has no network and no secrets. It can&apos;t start other programs, and it can
          read only the job&apos;s own files. The{" "}
          <a href={repoFile("docs/SECURITY.md")}>threat model</a> lists each guard and its test.
        </p>
      </DocsSection>

      <DocsSection id="deterministic" title="The same commit, the same diagram">
        <p>
          The diagram comes from the code alone: no timestamps, no randomness, every list in a fixed
          order. Analyzing the same commit again gives the same file, byte for byte. So when two
          commits&apos; diagrams differ, the code changed.
        </p>
      </DocsSection>

      <DocsSection id="requests" title="Requests matched to routes">
        <p>
          For each <code>fetch</code> or axios call, the analyzer works out the URL from the code:
          string literals, constants, wrapper functions, and the base URLs in committed example env
          files. It then matches that URL to the Express or Next.js route it reaches, and says how
          sure the match is: exact, a pattern, or a heuristic.
        </p>
      </DocsSection>

      <DocsSection id="unresolved" title="Gaps stay visible">
        <p>
          When the analyzer can&apos;t work something out, such as a URL only known when the code
          runs, or a request no route matches, it draws an unresolved box with the reason. It never
          drops the call, and it never guesses a line.
        </p>
      </DocsSection>

      <DocsSection id="readme-and-prs" title="README images and pull requests">
        <p>
          A repo&apos;s page offers a badge and a diagram image for its README. Each time one is
          viewed, GitInside checks the default branch for a new commit and analyzes it, so the image
          stays current. A private repo&apos;s README only ever gets a link-only badge.
        </p>
        <p>
          With the GitHub App installed, each pull request gets a <code>GitInside</code> check and
          one comment, updated in place on each push, with the architecture diff and any broken
          connections: a call whose route, function, file, or model field the change removed while
          something still calls it.
        </p>
      </DocsSection>

      <DocsSection id="coverage" title="What it reads">
        <p>
          TypeScript and JavaScript: React and Next.js, Express and Next.js API routes, Prisma,
          docker-compose and <code>.env</code>, and workspace monorepos. Fastify, NestJS, and Hono
          aren&apos;t read yet. Each detector&apos;s patterns, and the ones it doesn&apos;t handle,
          are in <a href={repoFile("docs/COVERAGE.md")}>COVERAGE.md</a>. How big a repo can be is on{" "}
          <Link href="/limits">Limits</Link>.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
