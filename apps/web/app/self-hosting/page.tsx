import type { Metadata } from "next";
import { REPO_HREF, repoFile } from "../../lib/docs";
import { DocsPage, DocsSection } from "../_docs/DocsPage";

export const metadata: Metadata = {
  title: "Self-hosting",
  description:
    "Run GitInside's analyzer on your own machine, or the whole website with its worker, from the MIT-licensed source.",
};

/** Running GitInside yourself (M9.4a): the CLI, the website locally, and a deployment. */
export default function SelfHosting() {
  return (
    <DocsPage
      current="/self-hosting"
      lede={
        <>
          GitInside is open source under the MIT license. The code is{" "}
          <a href={REPO_HREF}>on GitHub</a>. These are notes, not a supported product: it&apos;s
          built and tested for one deployment.
        </>
      }
    >
      <DocsSection id="cli" title="The analyzer on your machine">
        <p>
          The CLI runs the same analysis as the website on a folder you have, and nothing leaves
          your machine. It isn&apos;t published to npm, so you build it from the repo, with Node 22
          or later and pnpm:
        </p>
        <pre className="docs__code">
          <code>
            {[
              "pnpm install",
              "pnpm build",
              "node packages/analyzer/dist/cli.js analyze path/to/repo --out architecture.json",
            ].join("\n")}
          </code>
        </pre>
        <p>
          The output is the graph the diagram draws, in the{" "}
          <a href={repoFile("docs/GRAPH_SCHEMA.md")}>graph schema</a>. The <code>diff</code> command
          compares two commits, as the pull request bot does, and <code>--format mermaid</code>{" "}
          prints the change as a flowchart:
        </p>
        <pre className="docs__code">
          <code>node packages/analyzer/dist/cli.js diff main my-branch --repo path/to/repo</code>
        </pre>
        <p>
          The <a href={`${REPO_HREF}#quickstart-analyzer-cli`}>README</a> lists what the graph
          covers.
        </p>
      </DocsSection>

      <DocsSection id="local" title="The website, locally">
        <p>
          The website needs Postgres, an S3-compatible bucket for the diagrams, and the worker that
          runs analyses. Locally, it can hand each job straight to a worker on your machine instead
          of Google Cloud Tasks. The README&apos;s{" "}
          <a href={`${REPO_HREF}#quickstart-website-local`}>local quickstart</a> has the steps, and{" "}
          <code>infra/docker-compose.dev.yml</code> starts the database.
        </p>
        <p>
          The settings each part reads are listed, without values, in{" "}
          <a href={repoFile("apps/web/.env.example")}>apps/web/.env.example</a> and{" "}
          <a href={repoFile("apps/worker/.env.example")}>apps/worker/.env.example</a>. Private repos
          and the pull request bot also need a GitHub App of your own.
        </p>
      </DocsSection>

      <DocsSection id="deploy" title="A deployment">
        <p>
          GitInside itself runs the website on Vercel and the worker on Google Cloud Run, fed by
          Cloud Tasks, with Neon for Postgres and Oracle Object Storage for the diagrams, all on
          free plans. <a href={repoFile("infra/gcp/README.md")}>infra/gcp</a> holds the
          worker&apos;s reviewed service, queue, and permission settings, with every command that
          applies them and a script that checks a live project against them.
        </p>
        <p>
          Whatever you run it on, keep the analysis sandboxed as the worker does: a repo is
          untrusted input. The <a href={repoFile("docs/SECURITY.md")}>threat model</a> says what
          each guard protects against.
        </p>
      </DocsSection>
    </DocsPage>
  );
}
