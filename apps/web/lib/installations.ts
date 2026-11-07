import type { InstallationFacts } from "@gitinside/db";
import {
  apiHeaders,
  call,
  field,
  githubUrl,
  LOGIN,
  SignInError,
  type OAuthClient,
} from "./githubOAuth";

/**
 * The signed-in user's installations of the GitHub App and their repos (M8.2c), as the
 * dashboard lists them: `GET /user/installations` and `GET /user/installations/{id}/repositories`
 * with the user's token. GitHub answers both with only what the app is installed on *and* the
 * user can see, so nothing here filters access itself.
 *
 * Handled: up to {@link MAX_INSTALLATIONS} installations (one page) and
 * {@link MAX_REPO_PAGES} pages of 100 repos each, with GitHub's `total_count` so the page can
 * say how many more there are. Not handled: suspended installations are listed like the rest
 * (M8.3 decides what a suspension means); more installations than one page holds are cut, and
 * the count says so.
 *
 * {@link findUserInstallation} (M8.3b) looks one installation up the same way, for the install
 * return to check against the signed-in user rather than trust the query.
 */

/** Installations read: one page of GitHub's largest size. */
export const MAX_INSTALLATIONS = 100;
/** Pages of 100 repos read per installation. */
export const MAX_REPO_PAGES = 3;
/** Installations whose repos are read at once. */
const READS_AT_ONCE = 8;

/** A repo an installation covers. */
export interface InstalledRepo {
  owner: string;
  name: string;
  private: boolean;
}

/** One installation of the app, on a user or an organization. */
export interface Installation {
  id: number;
  /** The account it's installed on. */
  account: string;
  accountType: "User" | "Organization";
  /** Whether it covers all the account's repos or a chosen few. */
  selection: "all" | "selected";
  /** The repos read, sorted by owner and name. */
  repos: InstalledRepo[];
  /** How many repos GitHub says it covers that the user can see (≥ `repos.length`). */
  totalRepos: number;
}

/** What {@link listInstallations} read. */
export interface Installations {
  installations: Installation[];
  /** How many installations GitHub says the user can see (≥ `installations.length`). */
  total: number;
}

/** A repo name as GitHub allows it. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Case-insensitive, then by code unit, so the order never depends on the locale. */
function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function count(body: unknown): number {
  const total = field(body, "total_count");
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new SignInError("no total_count");
  }
  return total;
}

function list(body: unknown, name: string): unknown[] {
  const items = field(body, name);
  if (!Array.isArray(items)) throw new SignInError(`no ${name}`);
  return items;
}

function readInstallation(item: unknown): Omit<Installation, "repos" | "totalRepos"> {
  const id = field(item, "id");
  const account = field(item, "account");
  const login = field(account, "login");
  const type = field(account, "type");
  const selection = field(item, "repository_selection");
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new SignInError("installation without an ID");
  }
  if (typeof login !== "string" || !LOGIN.test(login)) {
    throw new SignInError("installation without an account");
  }
  return {
    id,
    account: login,
    accountType: type === "Organization" ? "Organization" : "User",
    selection: selection === "selected" ? "selected" : "all",
  };
}

function readRepo(item: unknown): InstalledRepo {
  const owner = field(field(item, "owner"), "login");
  const name = field(item, "name");
  if (typeof owner !== "string" || !LOGIN.test(owner)) throw new SignInError("repo without owner");
  if (typeof name !== "string" || !REPO_NAME.test(name) || name === "." || name === "..") {
    throw new SignInError("repo without a name");
  }
  return { owner, name, private: field(item, "private") === true };
}

async function readRepos(
  client: OAuthClient,
  accessToken: string,
  installationId: number,
): Promise<{ repos: InstalledRepo[]; totalRepos: number }> {
  const repos: InstalledRepo[] = [];
  let totalRepos = 0;
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const path = `/user/installations/${installationId}/repositories?per_page=100&page=${page}`;
    const body = await call(client, githubUrl(client, "api", path), {
      headers: apiHeaders(accessToken),
    });
    totalRepos = count(body);
    const items = list(body, "repositories");
    repos.push(...items.map(readRepo));
    if (items.length < 100 || repos.length >= totalRepos) break;
  }
  repos.sort((a, b) => byName(a.owner, b.owner) || byName(a.name, b.name));
  return { repos, totalRepos: Math.max(totalRepos, repos.length) };
}

/** Pages of 100 installations {@link findUserInstallation} reads looking for one. */
export const MAX_FIND_PAGES = 10;

/** GitHub's facts about one installation, as the install return stores them (M8.3b). */
function readFacts(item: unknown): InstallationFacts {
  const { id, account } = readInstallation(item);
  const accountId = field(field(item, "account"), "id");
  const accountType = field(field(item, "account"), "type");
  const suspended = field(item, "suspended_at");
  if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new SignInError("installation without an account ID");
  }
  if (accountType !== "User" && accountType !== "Organization") {
    throw new SignInError("installation with an unknown account type");
  }
  const suspendedAt = typeof suspended === "string" ? new Date(suspended) : null;
  if (
    (suspended !== null && typeof suspended !== "string") ||
    (suspendedAt !== null && Number.isNaN(suspendedAt.getTime()))
  ) {
    throw new SignInError("installation with a bad suspended_at");
  }
  return { githubInstallationId: id, accountId, accountLogin: account, accountType, suspendedAt };
}

/**
 * The installation with GitHub's ID `installationId`, if GitHub lists it among the user's own
 * (`GET /user/installations` with their token, up to {@link MAX_FIND_PAGES} pages), read from
 * GitHub's answer; `undefined` if it isn't there. Throws as {@link listInstallations} does.
 */
export async function findUserInstallation(
  client: OAuthClient,
  accessToken: string,
  installationId: number,
): Promise<InstallationFacts | undefined> {
  for (let page = 1; page <= MAX_FIND_PAGES; page++) {
    const path = `/user/installations?per_page=100&page=${page}`;
    const body = await call(client, githubUrl(client, "api", path), {
      headers: apiHeaders(accessToken),
    });
    const total = count(body);
    const items = list(body, "installations");
    const found = items.find((item) => field(item, "id") === installationId);
    if (found !== undefined) return readFacts(found);
    if (items.length < 100 || page * 100 >= total) break;
  }
  return undefined;
}

/**
 * The user's installations of the app and the repos each covers, sorted by account. Throws
 * {@link SignInError} when GitHub can't be read or answers out of shape, and its
 * `TokenRefusedError` when the token is refused (the session has ended).
 */
export async function listInstallations(
  client: OAuthClient,
  accessToken: string,
): Promise<Installations> {
  const body = await call(
    client,
    githubUrl(client, "api", `/user/installations?per_page=${MAX_INSTALLATIONS}`),
    { headers: apiHeaders(accessToken) },
  );
  const total = count(body);
  const found = list(body, "installations").slice(0, MAX_INSTALLATIONS).map(readInstallation);
  const installations: Installation[] = [];
  // A few at a time: GitHub's secondary rate limit punishes bursts of parallel calls.
  for (let i = 0; i < found.length; i += READS_AT_ONCE) {
    const batch = found.slice(i, i + READS_AT_ONCE);
    installations.push(
      ...(await Promise.all(
        batch.map(async (installation) => ({
          ...installation,
          ...(await readRepos(client, accessToken, installation.id)),
        })),
      )),
    );
  }
  installations.sort((a, b) => byName(a.account, b.account) || a.id - b.id);
  return { installations, total: Math.max(total, installations.length) };
}
