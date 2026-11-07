import { LinkButton, UiIcon } from "@gitinside/viewer";
import Link from "next/link";
import { installationSettingsUrl, type DashboardView } from "../../lib/dashboard";
import type { Installation } from "../../lib/installations";

/** "1 repo", "2 repos". */
const repos = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "repo" : "repos"}`;

function InstallationSection({ installation }: { installation: Installation }) {
  const { account, accountType, selection, repos: list, totalRepos } = installation;
  const headingId = `installation-${installation.id}`;
  const settings = installationSettingsUrl(installation);
  const hidden = totalRepos - list.length;
  return (
    <section className="installation" aria-labelledby={headingId}>
      <div className="installation__head">
        <h2 id={headingId} className="installation__account">
          {account}
        </h2>
        <span className="installation__meta">
          {accountType === "Organization" ? "Organization" : "Personal account"} ·{" "}
          {selection === "all" ? "All repos" : `${repos(totalRepos)} selected`}
        </span>
        <a className="installation__settings" href={settings} rel="noreferrer">
          Choose repos
          <UiIcon name="open-external" size={14} />
        </a>
      </div>
      {list.length === 0 ? (
        <p className="installation__none">
          {selection === "all"
            ? "No repos on this account yet."
            : "No repos selected on this account."}
        </p>
      ) : (
        <ul className="installation__repos">
          {list.map((repo) => (
            <li key={`${repo.owner}/${repo.name}`}>
              <Link className="repo-row" href={`/${repo.owner}/${repo.name}`}>
                <span className="repo-row__name">
                  <span className="repo-row__owner">{repo.owner}/</span>
                  {repo.name}
                </span>
                {repo.private && <span className="repo-row__tag">Private</span>}
                <UiIcon name="chevron-right" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="installation__more">
          {hidden.toLocaleString("en-US")} more {hidden === 1 ? "repo isn't" : "repos aren't"}{" "}
          listed here.{" "}
          <a href={settings} rel="noreferrer">
            See them on GitHub
          </a>
        </p>
      )}
    </section>
  );
}

/**
 * The dashboard's content (M8.2c, UX.md "Website flows"): one section per installation of
 * the app, its repos linking to their diagrams, then "Install on more repos". With no
 * installation, one card says what installing does; when GitHub can't be read, a note says
 * so with Try again.
 */
export function Dashboard({ view }: { view: Exclude<DashboardView, { kind: "ended" }> }) {
  const empty = view.kind === "ready" && view.installations.length === 0;
  return (
    <main className="dashboard">
      <div className="dashboard__head">
        <h1 className="dashboard__title">Your repos</h1>
        {view.installUrl !== undefined && !empty && (
          <LinkButton href={view.installUrl} rel="noreferrer" trailingIcon="open-external">
            Install on more repos
          </LinkButton>
        )}
      </div>
      <p className="dashboard__lede">
        Repos with GitInside installed that your GitHub account can see. Open one for its diagram.
      </p>

      {view.kind === "error" && (
        <div className="dashboard__card" role="alert" data-tone="error">
          <h2 className="dashboard__card-title">Your repos didn't load</h2>
          <p className="dashboard__card-text">
            We couldn't reach GitHub to list them. Try again in a moment.
          </p>
          <a className="dashboard__retry" href="/dashboard">
            Try again
          </a>
        </div>
      )}

      {empty && (
        <div className="dashboard__card">
          <h2 className="dashboard__card-title">GitInside isn't installed on your repos yet</h2>
          <p className="dashboard__card-text">
            Install the GitHub App on the repos you want diagrams of, private ones included. It
            reads code but never changes it, and comments on pull requests.
          </p>
          {view.installUrl !== undefined ? (
            <LinkButton
              href={view.installUrl}
              rel="noreferrer"
              variant="primary"
              trailingIcon="open-external"
            >
              Install GitInside
            </LinkButton>
          ) : (
            <p className="dashboard__card-text">Installing isn't available right now.</p>
          )}
        </div>
      )}

      {view.kind === "ready" &&
        view.installations.map((installation) => (
          <InstallationSection key={installation.id} installation={installation} />
        ))}

      {view.kind === "ready" && view.total > view.installations.length && (
        <p className="installation__more">
          Showing {view.installations.length} of {view.total} installations.
        </p>
      )}
    </main>
  );
}
