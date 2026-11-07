/**
 * The PR backtest's pinned inputs (docs/EVALUATION.md §3, ADR-0214): `eval/backtest/repos.json`
 * names the repos whose merged PRs are replayed, one shared date window, and the follow-up
 * period in which a later commit can fix a flagged break. Each repo pins two commits on its
 * branch: `startSha`, the last commit before the window opens (what was analyzed to pick it),
 * and `endSha`, the last commit before the follow-up period ends. Every merge commit replayed
 * and every fixing commit found must be an ancestor of `endSha`, so a later force-push or new
 * commit can't change what the replay sees. Candidates that failed a selection rule are listed
 * with the rule they failed, so the set can be checked against the rules rather than trusted.
 */
import { compareStrings } from "@gitinside/schema";
import { z } from "zod";
import { parseWith } from "../format.js";

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(
    (d) => {
      const parsed = new Date(`${d}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
    },
    { message: "not a calendar date" },
  );

const fullName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"');

const count = z.number().int().min(0);

/** `date` (YYYY-MM-DD) plus `days` calendar days, in UTC. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What was measured on a candidate when it was pinned, at `startSha`. */
export const measuredSchema = z
  .object({
    /** Merged PRs into `branch` with a merge date in the window, per GitHub's search. */
    mergedPrs: count,
    /** File nodes in the analyzer's graph. */
    files: count,
    /** `http` edges that reach a route: only these can break. */
    httpToRoute: count,
    /**
     * Those with a call site in app code: not in a service named like a test package, and not
     * in a `tests`, `__tests__`, `e2e`, `cypress`, or `playwright` folder or a `*.test.*` or
     * `*.spec.*` file.
     */
    appHttpToRoute: count,
  })
  .strict();

/** One pinned backtest repo. */
export const backtestRepoSchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    url: z.string(),
    /** GitHub's SPDX ID for the license, or `NOASSERTION` for a custom one. Only read, never copied. */
    license: z.string().min(1),
    /** The branch the replayed PRs merged into (the default branch when pinned). */
    branch: z.string().min(1),
    startSha: sha,
    endSha: sha,
    /** What the repo exercises: its frontend, backend, and how they call each other. */
    why: z.string().min(1),
    measured: measuredSchema,
  })
  .strict()
  .refine((r) => r.measured.appHttpToRoute <= r.measured.httpToRoute, {
    message: "app-code edges can't outnumber all edges",
    path: ["measured", "appHttpToRoute"],
  })
  .refine((r) => r.url === `https://github.com/${r.owner}/${r.name}`, {
    message: "url must be https://github.com/<owner>/<name>",
    path: ["url"],
  })
  .refine((r) => r.startSha !== r.endSha, {
    message: "the window's end must be a later commit than its start",
    path: ["endSha"],
  });

export type BacktestRepo = z.infer<typeof backtestRepoSchema>;

/**
 * A candidate that was looked at and left out: the first rule it fails (1-based, into `rules`)
 * and the fact that fails it.
 */
export const rejectedSchema = z
  .object({ repo: fullName, rule: z.number().int().min(1), reason: z.string().min(1) })
  .strict();

/** Report each out-of-order or duplicate neighbor in `keys` under `path`. */
function checkSorted(
  keys: readonly string[],
  path: string,
  what: string,
  ctx: z.RefinementCtx,
): void {
  for (let i = 1; i < keys.length; i++) {
    const order = compareStrings(keys[i - 1] as string, keys[i] as string);
    if (order >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, i],
        message: order === 0 ? `duplicate ${what}` : `${what} out of order (must be sorted)`,
      });
    }
  }
}

/** `eval/backtest/repos.json`. */
export const backtestReposFileSchema = z
  .object({
    /** The day the repos were picked and their SHAs read. */
    pinned: date,
    /** PRs merged into each repo's branch from `from` through `to` (UTC days, inclusive). */
    window: z.object({ from: date, to: date }).strict(),
    /**
     * At most this many PRs are replayed per repo: the earliest merged in the window, by merge
     * time (ties by PR number), so a busy repo's share is fixed before anything is replayed.
     */
    maxPrsPerRepo: z.number().int().min(1),
    /** Days after `window.to` in which a later commit counts as fixing a flagged break. */
    followUpDays: z.number().int().min(1),
    /** The selection rules, in the order they were applied; rule `n` is `rules[n - 1]`. */
    rules: z.array(z.string().min(1)).min(1),
    /** Where the candidates came from (lists and searches), so the walk can be repeated. */
    candidates: z.string().min(1),
    repos: z.array(backtestRepoSchema).min(1),
    rejected: z.array(rejectedSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const issue = (path: (string | number)[], message: string): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (file.window.to < file.window.from)
      issue(["window", "to"], "must not be before window.from");
    const end = addDays(file.window.to, file.followUpDays);
    if (file.pinned <= end) {
      issue(
        ["pinned"],
        `the follow-up (window.to + ${file.followUpDays} days = ${end}) must have ended before the repos were pinned`,
      );
    }
    const pinned = file.repos.map((r) => `${r.owner}/${r.name}`.toLowerCase());
    checkSorted(pinned, "repos", "repo", ctx);
    const rejected = file.rejected.map((r) => r.repo.toLowerCase());
    checkSorted(rejected, "rejected", "rejected repo", ctx);
    rejected.forEach((name, i) => {
      if (pinned.includes(name))
        issue(["rejected", i, "repo"], `${name} is both pinned and rejected`);
    });
    file.rejected.forEach((r, i) => {
      if (r.rule > file.rules.length) {
        issue(["rejected", i, "rule"], `there is no rule ${r.rule} (${file.rules.length} rules)`);
      }
    });
  });

export type BacktestReposFile = z.infer<typeof backtestReposFileSchema>;

/** Parse and validate the text of `eval/backtest/repos.json`; `file` names it in errors. */
export function parseBacktestReposFile(file: string, text: string): BacktestReposFile {
  return parseWith(backtestReposFileSchema, file, text);
}
