import {
  consumeRateLimit,
  findComputePause,
  findPublishedAnalysis,
  findPullRequestDiffKey,
  findStoredAnalysis,
  hideRepo,
  isPrivateSnapshot,
  refundRateLimit,
  servedPrivately,
  type AnyDatabase,
  type PublishedAnalysis,
  type StoredAnalysis,
} from "@gitinside/db";
import { readSession, userAccessToken, type AuthDeps, type SignedInUser } from "./authRoute";
import { findTooMuchCode, type CodeSizeCache } from "./codeSize";
import { COMMIT_SHA, type BaseView, type SearchParams } from "./compare";
import {
  InstallationRefusedError,
  QUEUE_UNAVAILABLE,
  enqueueAnalysis,
  findAnalysisToQueue,
  type EnqueueDeps,
  type EnqueueResult,
  type InstallationRefusal,
  type QueueRepo,
} from "./enqueue";
import {
  resolveRepo,
  resolveRepoById,
  type GitHubOptions,
  type ResolvedRepo,
  type ResolveResult,
  type SeenRepo,
  type SeenResult,
} from "./github";
import { userGitHub } from "./privateRepo";
import { checkRepoAccess } from "./repoAccess";
import type { RepoRef } from "./repoUrl";
import { findSizeHold } from "./sizeHold";

/**
 * What a repo page shows, with check-on-view re-analysis (SPEC §3 "Viewing re-analyzes
 * automatically if the default branch has a new commit", ADR-0068):
 *
 * 1. **Find** the newest finished analysis of the public repo (of the commit, on a
 *    `/<owner>/<repo>/<sha>` permalink). None: GitHub is asked whether the repo has another
 *    name now (`findRenamed`, M5.13b3) and the page follows it; else the repo page offers
 *    "Analyze", which goes through `/api/analyze` and the visitor's rate limit; a permalink
 *    is a 404.
 * 2. **Permalinks stop there:** a commit's diagram never changes, so no GitHub call.
 * 3. **Check** the default branch's latest commit on GitHub, remembered per repo and shown
 *    analysis for {@link HEAD_TTL_MS} so busy pages don't spend GitHub's hourly quota. If
 *    GitHub can't be asked, the diagram is still shown (`unknown`). If GitHub says it's gone or
 *    private now, it's a 404, and the repo is hidden (`hideRepo`) so its permalinks, graphs,
 *    and images stop too: a repo that went private must stop being served publicly. Then
 *    the CDN's copies of its graphs are purged by GitHub's ID (`purgeRepo`, M8.4d1, ADR-0238).
 * 4. **Up to date** when the shown analysis is that commit by this analyzer version.
 *    Otherwise the newer commit's own state decides: finished ⇒ shown instead; in flight
 *    ⇒ `updating`; failed ⇒ `behind` with its code (a failure isn't re-run on every view;
 *    "Analyze again" retries one that could pass); the repo held after a `LIMIT_*` failure
 *    (`findSizeHold`, #11) ⇒ `behind`, `too-big`; over twice the supported size of TypeScript
 *    and JavaScript by GitHub's count (`findTooMuchCode`, ADR-0154) ⇒ `behind`,
 *    `too-much-code`; new analyses paused for the month's compute (`findComputePause`,
 *    ADR-0156) ⇒ `behind`, `paused`; none, a row whose task was never created
 *    (`QUEUE_UNAVAILABLE`), or one `queued` with no task coming any more
 *    (`findAnalysisToQueue`, R10) ⇒ enqueued on Cloud Tasks (`enqueueAnalysis`).
 * 5. **Who pays:** re-analysis on view is charged to the repo, not the visitor
 *    (`repo:<GitHub ID>`, {@link RECHECKS_PER_HOUR} per hour), since a README image or a
 *    shared link is viewed by many people at once, and only a repo someone already paid to
 *    analyze is ever re-analyzed this way. The slot is refunded when no new job was made.
 *
 * **Private repos** (M8.4c1, ADR-0233): only with a {@link RepoViewer} (the pages, never the
 * README images), and only to a signed-in user `checkRepoAccess` allows (cached 60 s,
 * ADR-0231). Then the newest stored analysis is shown (of the commit, on a permalink), with no
 * GitHub call by the server's token, which can't see the repo. The repo page checks for newer
 * commits with the viewer's own token instead and queues them through the repo's installation
 * (`privateHead`, M8.4c2, ADR-0234). Signed out, refused, or the session ended: the view goes on exactly as if no private repo
 * had the name (a permalink's `missing`, the repo page's lookup as written), so a page never
 * confirms that a private repo exists. A check that can't decide throws
 * {@link RepoAccessUnavailableError}: the page says "temporarily unavailable".
 *
 * **Repos turned public** (M8.4d2, ADR-0239): an analysis stored under `private/` is shown only
 * this way, behind the check, whatever the repo's visibility now; public lookups never find it.
 * A commit analyzed privately is analyzed again as a public job: by check-on-view (a public
 * page's newer commit, or a private page whose repo GitHub says is public now) and by "Analyze".
 * Until then a signed-out visitor sees the repo as not analyzed.
 */

/** Who's looking at a page, for private repos: the request's `Cookie` header and sign-in's deps. */
export interface RepoViewer {
  cookie: string | null;
  auth: AuthDeps;
}

/** Thrown when a private repo's access check can't decide (GitHub down): nothing is shown. */
export class RepoAccessUnavailableError extends Error {
  override name = "RepoAccessUnavailableError";
  constructor() {
    super("the access check couldn't decide");
  }
}

/** How long a repo's latest commit, as GitHub last said, is trusted. */
export const HEAD_TTL_MS = 60_000;
/** New commits check-on-view may analyze per repo per hour. */
export const RECHECKS_PER_HOUR = 6;
/**
 * Names with no analysis that may be looked up on GitHub per hour, site-wide (a rename,
 * M5.13b3): about a tenth of a token's 5,000, so made-up URLs can't spend the quota that
 * `/api/analyze` and check-on-view need. Past it, such a page offers "Analyze" unchecked.
 */
export const UNKNOWN_LOOKUPS_PER_HOUR = 500;
/** {@link UNKNOWN_LOOKUPS_PER_HOUR}'s `rate_limits` key (never `ip:` or `repo:`). */
export const UNKNOWN_LOOKUPS_KEY = "site:unknown-repo";

/**
 * Recent GitHub answers by repo, so repeated views cost one lookup a minute. Private repos'
 * (M8.4c2) are kept under their own keys (`#<GitHub ID>@…`), never a name's.
 */
export interface HeadCache {
  get(key: string): SeenResult | undefined;
  set(key: string, value: SeenResult): void;
}

/** A {@link HeadCache} in this process's memory; successful answers only, oldest dropped first. */
export function createHeadCache(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): HeadCache {
  const { ttlMs = HEAD_TTL_MS, maxEntries = 1_000, now = Date.now } = options;
  const entries = new Map<string, { value: SeenResult; expires: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expires > now()) return entry.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value) {
      if (!value.ok) return;
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
  };
}

/** Everything {@link viewRepo} talks to. */
export interface RepoViewDeps {
  db: AnyDatabase;
  /** Without a queue (not configured), newer commits are reported but not analyzed. */
  queue: EnqueueDeps["queue"] | undefined;
  github: GitHubOptions;
  /** `@gitinside/analyzer/version`. */
  analyzerVersion: string;
  heads: HeadCache;
  /** GitHub's code counts by commit (`findTooMuchCode`); without it, asked every time. */
  codeSizes?: CodeSizeCache;
  /** Default {@link RECHECKS_PER_HOUR}. */
  rechecksPerHour?: number;
  /** Default {@link UNKNOWN_LOOKUPS_PER_HOUR}. */
  unknownLookupsPerHour?: number;
  /** Who's viewing (the pages, with sign-in configured); without it, private repos never show. */
  viewer?: RepoViewer;
  /**
   * Drop the CDN's copies of a repo's graphs, by GitHub's ID (`purgeRepoCache`, ADR-0238),
   * once the repo is hidden; without it they stay until `s-maxage` ends.
   */
  purgeRepo?: (providerRepoId: number) => Promise<void>;
}

/** How the shown diagram relates to the default branch's latest commit. */
export type HeadState =
  /** A permalink: the commit in the URL, never checked. */
  | { state: "pinned" }
  /** The latest commit, by this analyzer version. */
  | { state: "current" }
  /** A newer analysis is queued or running; `jobId` opens its progress page when known. */
  | { state: "updating"; sha: string; jobId?: string }
  /** Newer than what's shown, but its analysis failed with `errorCode`. */
  | { state: "behind"; sha: string; reason: "failed"; errorCode: string }
  /** Newer than what's shown, but not being analyzed now. */
  | { state: "behind"; sha: string; reason: "limited" | "unavailable" }
  /**
   * Newer than what's shown, but an analysis of the repo hit `errorCode` (`LIMIT_*`) in the
   * past week, so new ones wait until `until` (ISO 8601) unless it shrinks (#11).
   */
  | { state: "behind"; sha: string; reason: "too-big"; errorCode: string; until: string }
  /**
   * Newer than what's shown, but GitHub counts `codeBytes` of TypeScript and JavaScript in
   * the repo, over twice the supported size, so it isn't analyzed (ADR-0154).
   */
  | { state: "behind"; sha: string; reason: "too-much-code"; codeBytes: number }
  /**
   * Newer than what's shown, but new analyses are paused until `until` (ISO 8601, the next
   * UTC month): the month's compute reached 80% of Google's free allowance (ADR-0156).
   */
  | { state: "behind"; sha: string; reason: "paused"; until: string }
  /** GitHub couldn't be asked. */
  | { state: "unknown" };

/** What a repo page renders. Owner and repo are our stored spelling (GitHub's). */
export type RepoView =
  | { status: "missing" }
  | { status: "not-analyzed"; owner: string; repo: string }
  /** GitHub knows the repo under another name now (a rename or transfer): open that one. */
  | { status: "moved"; owner: string; repo: string }
  | {
      status: "ready";
      owner: string;
      repo: string;
      sha: string;
      analyzerVersion: string;
      /** Where the browser fetches the graph (`/api/graph/…`). */
      graphUrl: string;
      head: HeadState;
      /** Set only for a private repo the viewer was allowed to see: GitHub's ID for it. */
      private?: { providerRepoId: number };
    };

/** `/api/graph/<owner>/<repo>/<sha>`. */
export function graphPath(owner: string, repo: string, sha: string): string {
  return `/api/graph/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}`;
}

function ready(published: PublishedAnalysis | StoredAnalysis, head: HeadState): RepoView {
  const { owner, name } = published.repo;
  const { sha, analyzerVersion } = published.analysis;
  return {
    status: "ready",
    owner,
    repo: name,
    sha,
    analyzerVersion,
    graphUrl: graphPath(owner, name, sha),
    head,
    ...(isStored(published) &&
      servedPrivately(published) && {
        private: { providerRepoId: published.repo.providerRepoId },
      }),
  };
}

/** Whether `found` came from `findStoredAnalysis` (it carries the repo's visibility). */
function isStored(found: PublishedAnalysis | StoredAnalysis): found is StoredAnalysis {
  return "visibility" in found.repo;
}

/** A private repo's analysis shown to a signed-in viewer `checkRepoAccess` allowed. */
interface AllowedPrivate {
  stored: StoredAnalysis;
  user: SignedInUser;
  viewer: RepoViewer;
}

/**
 * The newest analysis of the private repo `ref` names (of `ref.sha` when set), if the viewer is
 * signed in and GitHub shows it to them; else `undefined` (see the module's notes). The session
 * is read first, so a signed-out view costs no lookup.
 */
async function privateAnalysis(
  ref: RepoRef & { sha?: string },
  deps: RepoViewDeps,
): Promise<AllowedPrivate | undefined> {
  const { viewer } = deps;
  if (viewer === undefined) return undefined;
  const user = await readSession(viewer.cookie, viewer.auth);
  if (user === undefined) return undefined;
  const stored = await findStoredAnalysis(deps.db, {
    owner: ref.owner,
    name: ref.repo,
    ...(ref.sha === undefined ? {} : { sha: ref.sha }),
  });
  if (stored === undefined || !servedPrivately(stored)) return undefined;
  const access = await checkRepoAccess(user, stored.repo, viewer.auth);
  if ("error" in access) throw new RepoAccessUnavailableError();
  return "allowed" in access && access.allowed ? { stored, user, viewer } : undefined;
}

/** A remembered answer if it's one `resolveRepo` could give (a public repo's), else a miss. */
function publicAnswer(cached: SeenResult | undefined): ResolveResult | undefined {
  if (cached === undefined || !cached.ok) return cached;
  const { repo } = cached;
  return repo.visibility === "public"
    ? { ok: true, repo: { ...repo, visibility: "public" } }
    : undefined;
}

/**
 * GitHub's answer for `ref`, remembered per repo **and per shown analysis**: once a newer
 * analysis is published (a job finished, often started by `/api/analyze`, which asked GitHub
 * itself), an answer remembered before it may name an older commit, and would show that
 * older commit's diagram as "up to date" (M5 review). Keying on the shown analysis makes
 * that answer a miss, so a publish costs one more lookup, never a wrong label.
 */
async function latestCommit(
  ref: RepoRef,
  shown: PublishedAnalysis["analysis"],
  deps: RepoViewDeps,
): Promise<ResolveResult> {
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  const key = `${repo}@${shown.sha}/${shown.analyzerVersion}`;
  const cached = publicAnswer(deps.heads.get(key));
  if (cached !== undefined) return cached;
  const resolved = await resolveRepo(ref, deps.github);
  deps.heads.set(key, resolved);
  return resolved;
}

/**
 * Check-on-view for a private repo shown to `allowed` (M8.4c2): the default branch's latest
 * commit is asked by GitHub's ID with the viewer's own token (the server's can't see the repo),
 * on the API the sign-in client uses, and remembered like a public repo's, under the repo's ID
 * (shared between viewers: each was allowed by the check before reaching it). A newer commit is
 * queued through the installation the repo is linked to, charged to the repo as on a public
 * page, its code counted with the same token.
 *
 * `unknown` when the viewer's token can't be had or GitHub can't answer. When GitHub says the
 * repo is public now, its latest commit is queued as a public job (M8.4d2, ADR-0239), even when
 * it's the shown one: what was analyzed privately is only ever shown behind the check, so it's
 * analyzed again under the public key, where public pages find it. A repo with no linked
 * installation (uninstalled) is `behind` with `INSTALLATION_NOT_FOUND`, as a job refused at
 * enqueue would be.
 */
async function privateHead(allowed: AllowedPrivate, deps: RepoViewDeps): Promise<RepoView> {
  const { stored, user, viewer } = allowed;
  const unknown = ready(stored, { state: "unknown" });
  const access = await userAccessToken(user, viewer.auth);
  if (!("token" in access)) return unknown;
  const github = userGitHub(access.token, viewer.auth.client, deps.github);
  const { analysis } = stored;
  const key = `#${stored.repo.providerRepoId}@${analysis.sha}/${analysis.analyzerVersion}`;
  let resolved = deps.heads.get(key);
  if (resolved === undefined) {
    resolved = await resolveRepoById(stored.repo.providerRepoId, github);
    deps.heads.set(key, resolved);
  }
  if (!resolved.ok) return unknown;
  const head = resolved.repo;
  const { providerRepoId, githubInstallationId } = stored.repo;
  if (head.visibility === "public") {
    // Public now (M8.4d2, ADR-0239): a public job, so the commit is analyzed again under the
    // public key (the shown one too, if it's stored under `private/`) and pages find it.
    return followHead(stored, { ...head, visibility: "public" }, deps, {
      github: deps.github,
      latest: (sha) => findPublishedAnalysis(deps.db, { providerRepoId, sha }),
    });
  }
  if (githubInstallationId === null) {
    if (isCurrent(stored, head, deps)) return ready(stored, { state: "current" });
    const errorCode: InstallationRefusal = "INSTALLATION_NOT_FOUND";
    return ready(stored, { state: "behind", sha: head.sha, reason: "failed", errorCode });
  }
  return followHead(
    stored,
    { ...head, visibility: "private", installationId: githubInstallationId },
    deps,
    {
      github,
      latest: (sha) => findStoredAnalysis(deps.db, { providerRepoId, sha }),
    },
  );
}

/**
 * Where a `moved` repo page goes: `/<owner>/<repo>` in GitHub's new spelling, with the page's
 * query as it came (each value of a repeated key, in order), so a deep link survives.
 */
export function movedPath(
  moved: { owner: string; repo: string },
  query: SearchParams = {},
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (one !== undefined) search.append(key, one);
    }
  }
  const path = `/${encodeURIComponent(moved.owner)}/${encodeURIComponent(moved.repo)}`;
  return search.size === 0 ? path : `${path}?${search.toString()}`;
}

/** `/api/diff/<owner>/<repo>/<base>/<head>`: a pull request's stored diff (M8.6f1). */
export function diffPath(owner: string, repo: string, base: string, head: string): string {
  return `/api/diff/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${base}/${head}`;
}

/**
 * What a link's `?base=<sha>` compares the shown diagram with (diff mode, M6.9e2): that
 * commit's published analysis of the same repo (looked up by the stored spelling, like a
 * permalink: never checked against GitHub, nothing enqueued). `base` is the raw value. A
 * private repo shown after its check (M8.4c1) compares with its own analyses, found by
 * GitHub's ID, so the check covers the base too. When `shown` names its commit and analyzer
 * version (a `ready` view does) and a pull request record of the repo names a stored diff of
 * `base`...that commit by that version (`findPullRequestDiffKey`, M8.6f1), the base also says
 * where that diff is; `/api/diff` checks access again before serving it.
 */
export async function viewBase(
  shown: {
    owner: string;
    repo: string;
    sha?: string;
    analyzerVersion?: string;
    private?: { providerRepoId: number } | undefined;
  },
  base: string,
  db: AnyDatabase,
): Promise<BaseView> {
  if (!COMMIT_SHA.test(base)) return { status: "invalid" };
  const published =
    shown.private === undefined
      ? await findPublishedAnalysis(db, { owner: shown.owner, name: shown.repo, sha: base })
      : await findStoredAnalysis(db, { providerRepoId: shown.private.providerRepoId, sha: base });
  if (published === undefined) return { status: "missing", sha: base };
  const { owner, name } = published.repo;
  const view = { status: "ready", sha: base, graphUrl: graphPath(owner, name, base) } as const;
  if (shown.sha === undefined || shown.analyzerVersion === undefined) return view;
  const diffKey = await findPullRequestDiffKey(db, {
    repoId: published.repo.id,
    baseSha: base,
    headSha: shown.sha,
    analyzerVersion: shown.analyzerVersion,
  });
  return diffKey === undefined
    ? view
    : { ...view, diffUrl: diffPath(owner, name, base, shown.sha) };
}

/** Whether GitHub's names are the URL's, ignoring case (GitHub's own rule). */
function sameName(head: ResolvedRepo, ref: RepoRef): boolean {
  return (
    head.owner.toLowerCase() === ref.owner.toLowerCase() &&
    head.name.toLowerCase() === ref.repo.toLowerCase()
  );
}

/**
 * A name with no published analysis (M5.13b3). GitHub answers a renamed or transferred
 * repo's old name with the repo itself (`resolveRepo` follows the redirect), so ask it:
 * - another name ⇒ `moved` there, so old links and README images keep working;
 * - the same name ⇒ the repo by GitHub's ID, if it was analyzed under an older name (else
 *   `not-analyzed` in GitHub's spelling);
 * - GitHub can't say (not found, unavailable), or {@link UNKNOWN_LOOKUPS_PER_HOUR} is used
 *   up ⇒ `not-analyzed` as written, as before: "Analyze" asks GitHub again anyway.
 *
 * Answers are remembered like check-on-view's, so a busy old link asks once a minute.
 */
async function findRenamed(
  ref: RepoRef,
  deps: RepoViewDeps,
): Promise<RepoView | { published: PublishedAnalysis; resolved: ResolveResult }> {
  const { db } = deps;
  const notAnalyzed: RepoView = { status: "not-analyzed", owner: ref.owner, repo: ref.repo };
  const key = `${ref.owner}/${ref.repo}@unknown`.toLowerCase();
  let resolved = publicAnswer(deps.heads.get(key));
  if (resolved === undefined) {
    const limit = deps.unknownLookupsPerHour ?? UNKNOWN_LOOKUPS_PER_HOUR;
    if (!(await consumeRateLimit(db, UNKNOWN_LOOKUPS_KEY, limit)).allowed) return notAnalyzed;
    resolved = await resolveRepo(ref, deps.github);
    deps.heads.set(key, resolved);
  }
  if (!resolved.ok) return notAnalyzed;
  const head = resolved.repo;
  if (!sameName(head, ref)) return { status: "moved", owner: head.owner, repo: head.name };
  const published = await findPublishedAnalysis(db, { providerRepoId: head.providerRepoId });
  if (published === undefined)
    return { status: "not-analyzed", owner: head.owner, repo: head.name };
  return { published, resolved };
}

/**
 * Ask the CDN to drop a hidden repo's graphs. A failure is logged by name only and doesn't
 * change the view: the repo is already hidden, and the CDN's copies expire by `s-maxage`.
 */
async function purgeRepo(providerRepoId: number, deps: RepoViewDeps): Promise<void> {
  try {
    await deps.purgeRepo?.(providerRepoId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cdn_purge_failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

/** Decide what `/<owner>/<repo>` (or `/<owner>/<repo>/<sha>` with `sha`) shows. */
export async function viewRepo(
  ref: RepoRef & { sha?: string },
  deps: RepoViewDeps,
): Promise<RepoView> {
  const { db } = deps;
  let published = await findPublishedAnalysis(db, {
    owner: ref.owner,
    name: ref.repo,
    ...(ref.sha === undefined ? {} : { sha: ref.sha }),
  });
  if (published === undefined) {
    const allowed = await privateAnalysis(ref, deps);
    if (allowed !== undefined) {
      return ref.sha === undefined
        ? privateHead(allowed, deps)
        : ready(allowed.stored, { state: "pinned" });
    }
  }
  if (ref.sha !== undefined) {
    return published ? ready(published, { state: "pinned" }) : { status: "missing" };
  }
  let resolved: ResolveResult;
  if (published === undefined) {
    const found = await findRenamed(ref, deps);
    if ("status" in found) return found;
    ({ published, resolved } = found);
  } else {
    resolved = await latestCommit(ref, published.analysis, deps);
  }
  if (!resolved.ok) {
    if (resolved.code === "REPO_NOT_FOUND" || resolved.code === "REPO_UNAVAILABLE") {
      // Recorded, so its permalinks and graphs (which never ask GitHub) stop too.
      await hideRepo(db, published.repo.id);
      // Then out of the CDN: purged before the hide, its next ask could cache them again.
      // Every view that saw it public purges, so one that failed is retried by a racing one.
      await purgeRepo(published.repo.providerRepoId, deps);
      return { status: "missing" };
    }
    return ready(published, { state: "unknown" });
  }
  const head = resolved.repo;
  // The name now belongs to a different repo (the old one was renamed or deleted).
  if (head.providerRepoId !== published.repo.providerRepoId) {
    return { status: "not-analyzed", owner: head.owner, repo: head.name };
  }
  const { owner, name } = published.repo;
  return followHead(published, head, deps, {
    github: deps.github,
    latest: (sha) => findPublishedAnalysis(db, { owner, name, sha }),
  });
}

/** Whether `shown` is `head`'s commit by this analyzer version. */
function isCurrent(
  shown: PublishedAnalysis,
  head: Pick<SeenRepo, "sha">,
  deps: Pick<RepoViewDeps, "analyzerVersion">,
): boolean {
  const { analysis } = shown;
  return analysis.sha === head.sha && analysis.analyzerVersion === deps.analyzerVersion;
}

/**
 * Steps 4 and 5 of the module's notes, for a public repo or a private one (M8.4c2): how
 * `published` relates to `head`, GitHub's latest commit, queueing that commit if it's due. For
 * a public `head` (no installation), a commit stored under `private/` is never up to date.
 * `github` reads the repo's code count; `latest(sha)` finds a commit's finished analysis the
 * way this page may show it.
 */
async function followHead(
  published: PublishedAnalysis | StoredAnalysis,
  head: QueueRepo,
  deps: RepoViewDeps,
  how: {
    github: GitHubOptions;
    latest: (sha: string) => Promise<PublishedAnalysis | StoredAnalysis | undefined>;
  },
): Promise<RepoView> {
  const { db } = deps;
  // A public job analyzes again what was analyzed privately (M8.4d2), the shown commit too.
  const replacePrivate = head.installationId === undefined;
  const shownPrivately = replacePrivate && isPrivateSnapshot(published.analysis.snapshotKey);
  if (!shownPrivately && isCurrent(published, head, deps)) {
    return ready(published, { state: "current" });
  }

  const existing = await findAnalysisToQueue(
    db,
    { providerRepoId: head.providerRepoId, sha: head.sha, analyzerVersion: deps.analyzerVersion },
    { replacePrivate },
  );
  if (existing?.status === "done") {
    const latest = await how.latest(head.sha);
    if (latest !== undefined) return ready(latest, { state: "current" });
  }
  // A job that never got its task failed no analysis: try again, as if it had no row.
  if (existing?.status === "failed" && existing.errorCode !== QUEUE_UNAVAILABLE) {
    // `failed` rows always carry a code (schema.ts); the fallback is the worker's own.
    const errorCode = existing.errorCode ?? "WORKER_ERROR";
    return ready(published, { state: "behind", sha: head.sha, reason: "failed", errorCode });
  }
  const inFlight = existing?.status === "queued" || existing?.status === "running";
  const updating: HeadState = { state: "updating", sha: head.sha };
  const unavailable: HeadState = { state: "behind", sha: head.sha, reason: "unavailable" };
  if (deps.queue === undefined) return ready(published, inFlight ? updating : unavailable);
  if (!inFlight) {
    const hold = await findSizeHold(db, head);
    if (hold !== undefined) {
      const { errorCode, until } = hold;
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "too-big",
        errorCode,
        until: until.toISOString(),
      });
    }
    const codeBytes = await findTooMuchCode(head, how.github, deps.codeSizes);
    if (codeBytes !== undefined) {
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "too-much-code",
        codeBytes,
      });
    }
    const pause = await findComputePause(db);
    if (pause !== undefined) {
      return ready(published, {
        state: "behind",
        sha: head.sha,
        reason: "paused",
        until: pause.until.toISOString(),
      });
    }
  }

  const key = `repo:${head.providerRepoId}`;
  let charged: Date | undefined;
  if (!inFlight) {
    const limit = await consumeRateLimit(db, key, deps.rechecksPerHour ?? RECHECKS_PER_HOUR);
    if (!limit.allowed) {
      return ready(published, { state: "behind", sha: head.sha, reason: "limited" });
    }
    charged = limit.windowStart;
  }
  let queued: EnqueueResult;
  try {
    queued = await enqueueAnalysis(head, {
      db,
      queue: deps.queue,
      analyzerVersion: deps.analyzerVersion,
    });
  } catch (error) {
    if (!(error instanceof InstallationRefusedError)) throw error;
    // Uninstalled or suspended (a private repo): nothing was written, so nothing is charged.
    if (charged) await refundRateLimit(db, key, charged);
    const errorCode = error.code;
    return ready(published, { state: "behind", sha: head.sha, reason: "failed", errorCode });
  }
  const isNew = queued.status === "queued" && queued.entered;
  if (charged && !isNew) await refundRateLimit(db, key, charged);
  switch (queued.status) {
    case "done": {
      // Finished since the lookup above (a racing job).
      const latest = await how.latest(head.sha);
      return latest === undefined
        ? ready(published, updating)
        : ready(latest, { state: "current" });
    }
    case "unavailable":
      return ready(published, unavailable);
    default:
      return ready(published, { state: "updating", sha: head.sha, jobId: queued.jobId });
  }
}
