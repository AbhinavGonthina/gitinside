/**
 * A fresh blind sample drawn by a recorded rule (docs/EVALUATION.md §1, "Held-out batch 4",
 * M5C.5). The rule (search queries, a seed, how many to pin) is committed in
 * `eval/draws/batch-<n>.json` before any candidate is seen, with the repos it leaves out
 * (from batch 5, M5C.8). Each stratum's whole candidate pool is then snapshotted from
 * GitHub's search, stripped of those repos, shuffled by the seed, and walked in that
 * order: every candidate is read (never analyzed) and pinned or rejected with a reason, until
 * the stratum has its quota or the pool runs out. Nothing can be skipped, so the sample is
 * the seed's, not the reader's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "@gitinside/schema";
import { z } from "zod";
import { parseWith, type EvalRepo } from "./format.js";
import { seededShuffle } from "./sample.js";

/** GitHub's search API returns at most this many results for one query. */
export const SEARCH_CAP = 1000;

/** Results per search page, the API's maximum. */
export const PAGE_SIZE = 100;

const fullName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/** `owner/name` lowercased, the order pools are sorted in (GitHub names are case-insensitive). */
function nameKey(name: string): string {
  return name.toLowerCase();
}

/** One candidate read during the walk, with what was decided and why. */
export const examinedSchema = z
  .object({
    repo: fullName,
    verdict: z.enum(["pinned", "rejected"]),
    /** For a pin, the default-branch HEAD on the day it was read; absent for a rejection. */
    sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA")
      .optional(),
    /** Which inclusion rule a rejection fails, or what a pin exercises. */
    reason: z.string().min(1),
  })
  .strict()
  .refine((e) => (e.verdict === "pinned") === (e.sha !== undefined), {
    message: "a pinned candidate needs its sha, and a rejected one has none",
    path: ["sha"],
  });

export type Examined = z.infer<typeof examinedSchema>;

/** A stratum's candidate pool: every repo its query matched on the day it was fetched. */
export const poolSchema = z
  .object({
    fetched: date,
    total: z.number().int().min(0).max(SEARCH_CAP),
    repos: z.array(fullName),
  })
  .strict();

export type Pool = z.infer<typeof poolSchema>;

/** One search query, the share of the batch it supplies, and its walk so far. */
export const stratumSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, "must be lowercase kebab-case"),
    /** A GitHub repository search query, qualifiers included, exactly as sent. */
    query: z.string().min(1),
    /** `null` until the pool is fetched, after the rule is committed. */
    pool: poolSchema.nullable(),
    examined: z.array(examinedSchema),
  })
  .strict();

export type Stratum = z.infer<typeof stratumSchema>;

/** A repo left out of every pool before it is shuffled, and why (inclusion rule 1). */
export const exclusionSchema = z
  .object({
    repo: fullName,
    why: z.string().min(1),
  })
  .strict();

export type Exclusion = z.infer<typeof exclusionSchema>;

const drawObjectSchema = z
  .object({
    batch: z.number().int().min(1),
    /** Fixed when the rule is committed; each stratum shuffles with `<seed>/<name>`. */
    seed: z.string().min(1),
    /** How many repos each stratum pins before its walk stops. */
    perStratum: z.number().int().min(1),
    /**
     * Repos already in or read for the eval, committed with the rule, sorted by owner/name.
     * The walk never meets them. Absent in batch 4, whose reader checked rule 1 by hand.
     */
    exclude: z.array(exclusionSchema).optional(),
    strata: z.array(stratumSchema).min(1),
  })
  .strict();

export type DrawFile = z.infer<typeof drawObjectSchema>;

/** `eval/draws/batch-<n>.json`, with every check of {@link drawProblems}. */
export const drawFileSchema = drawObjectSchema.superRefine((file, ctx) => {
  for (const problem of drawProblems(file)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: problem.path, message: problem.message });
  }
});

/** Parse and validate the text of a draw file; `file` names it in errors. */
export function parseDrawFile(file: string, text: string): DrawFile {
  return parseWith(drawFileSchema, file, text);
}

/** The rule's excluded repos, by {@link nameKey}. */
function excludedKeys(draw: Pick<DrawFile, "exclude">): Set<string> {
  return new Set((draw.exclude ?? []).map((e) => nameKey(e.repo)));
}

/**
 * The order a stratum's pool is walked in: the sorted pool without the rule's excluded repos,
 * shuffled by `<seed>/<name>`.
 */
export function drawOrder(
  draw: Pick<DrawFile, "seed" | "exclude">,
  stratum: Pick<Stratum, "name">,
  pool: Pool,
): string[] {
  const excluded = excludedKeys(draw);
  const repos = pool.repos.filter((r) => !excluded.has(nameKey(r)));
  return seededShuffle(repos, `${draw.seed}/${stratum.name}`);
}

/** A problem with a draw file, at a JSON path. */
export interface DrawProblem {
  path: (string | number)[];
  message: string;
}

/**
 * Everything that makes a draw file's record untrustworthy: a pool that isn't the sorted,
 * whole result set, a walk that leaves the seeded order or goes past its quota, a repo pinned
 * twice, a stratum walked before its pool was recorded, or an exclusion list that isn't
 * sorted and distinct.
 */
export function drawProblems(file: DrawFile): DrawProblem[] {
  const problems: DrawProblem[] = [];
  const pinnedIn = new Map<string, string>();
  const names = new Set<string>();
  const exclude = file.exclude ?? [];
  for (let i = 1; i < exclude.length; i++) {
    const order = compareStrings(
      nameKey(exclude[i - 1]?.repo ?? ""),
      nameKey(exclude[i]?.repo ?? ""),
    );
    if (order >= 0) {
      problems.push({
        path: ["exclude", i, "repo"],
        message: order === 0 ? "excluded twice" : "exclusions must be sorted by owner/name",
      });
    }
  }
  const excluded = excludedKeys(file);
  file.strata.forEach((stratum, s) => {
    const at = (...rest: (string | number)[]): (string | number)[] => ["strata", s, ...rest];
    if (names.has(stratum.name)) {
      problems.push({ path: at("name"), message: `stratum ${stratum.name} appears twice` });
    }
    names.add(stratum.name);
    const { pool } = stratum;
    if (!pool) {
      if (stratum.examined.length > 0) {
        problems.push({ path: at("examined"), message: "walked before its pool was recorded" });
      }
      return;
    }
    if (pool.repos.length !== pool.total) {
      problems.push({
        path: at("pool", "repos"),
        message: `lists ${pool.repos.length} repos, but the search found ${pool.total}`,
      });
    }
    for (let i = 1; i < pool.repos.length; i++) {
      const prev = nameKey(pool.repos[i - 1] ?? "");
      const order = compareStrings(prev, nameKey(pool.repos[i] ?? ""));
      if (order >= 0) {
        problems.push({
          path: at("pool", "repos", i),
          message: order === 0 ? "duplicate repo" : "repos must be sorted by owner/name",
        });
      }
    }
    const order = drawOrder(file, stratum, pool);
    let pinned = 0;
    stratum.examined.forEach((entry, i) => {
      const expected = order[i];
      if (excluded.has(nameKey(entry.repo))) {
        problems.push({ path: at("examined", i, "repo"), message: `${entry.repo} is excluded` });
      } else if (pinned >= file.perStratum) {
        problems.push({
          path: at("examined", i),
          message: `the walk stops once ${file.perStratum} repos are pinned`,
        });
      } else if (expected === undefined) {
        problems.push({ path: at("examined", i), message: "the pool has no more repos" });
      } else if (nameKey(entry.repo) !== nameKey(expected)) {
        problems.push({
          path: at("examined", i, "repo"),
          message: `the seeded order's next repo is ${expected}, not ${entry.repo}`,
        });
      }
      if (entry.verdict !== "pinned") return;
      pinned++;
      const earlier = pinnedIn.get(nameKey(entry.repo));
      if (earlier !== undefined) {
        problems.push({
          path: at("examined", i, "verdict"),
          message: `${entry.repo} is already pinned in stratum ${earlier}`,
        });
      }
      pinnedIn.set(nameKey(entry.repo), stratum.name);
    });
  });
  return problems;
}

/** What remains of a stratum's walk. */
export type WalkState =
  | { state: "no-pool" }
  | { state: "next"; repo: string; pinned: number; examined: number }
  | { state: "done"; pinned: number; examined: number; exhausted: boolean };

/** Where a stratum's walk stands: waiting for its pool, the next repo to read, or done. */
export function walkState(file: DrawFile, stratum: Stratum): WalkState {
  if (!stratum.pool) return { state: "no-pool" };
  const order = drawOrder(file, stratum, stratum.pool);
  const pinned = stratum.examined.filter((e) => e.verdict === "pinned").length;
  const examined = stratum.examined.length;
  const repo = order[examined];
  if (pinned >= file.perStratum || repo === undefined) {
    return { state: "done", pinned, examined, exhausted: pinned < file.perStratum };
  }
  return { state: "next", repo, pinned, examined };
}

/** One page of GitHub's repository search response, the fields the pool needs. */
export interface SearchPage {
  total_count: number;
  incomplete_results: boolean;
  items: readonly { full_name: string }[];
}

/**
 * Fetch a query's whole result set, page by page, as a sorted pool. Fails rather than record
 * a partial pool: a query past the search cap, results GitHub marks incomplete, or pages that
 * shifted while being read (fewer distinct repos than the total).
 */
export async function collectPool(
  fetchPage: (page: number) => Promise<SearchPage>,
  fetched: string,
): Promise<Pool> {
  const first = await fetchPage(1);
  const total = first.total_count;
  if (total > SEARCH_CAP) {
    throw new Error(`the query matches ${total} repos, past the search cap of ${SEARCH_CAP}`);
  }
  const seen = new Map<string, string>();
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const result = page === 1 ? first : await fetchPage(page);
    if (result.incomplete_results) throw new Error(`page ${page}: GitHub's results are incomplete`);
    if (result.total_count !== total) {
      throw new Error(`page ${page}: the total changed from ${total} to ${result.total_count}`);
    }
    for (const item of result.items) seen.set(nameKey(item.full_name), item.full_name);
  }
  if (seen.size !== total) {
    throw new Error(`read ${seen.size} distinct repos of ${total}; the pages shifted, so retry`);
  }
  const repos = [...seen.values()].sort((a, b) => compareStrings(nameKey(a), nameKey(b)));
  return { fetched, total, repos };
}

/** Every `<root>/draws/*.json`, parsed and validated, sorted by file name. */
export function loadDrawFiles(root: string): { file: string; draw: DrawFile }[] {
  const dir = join(root, "draws");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort(compareStrings)
    .map((f) => ({
      file: f,
      draw: parseDrawFile(`draws/${f}`, readFileSync(join(dir, f), "utf8")),
    }));
}

/**
 * Problems between a draw, `repos.json`, and the other draw records: a repo in the draw's
 * batch that the walk didn't pin, or pinned at another SHA. A pin not yet in `repos.json` is
 * fine (it is added with its labels). When the draw has an exclusion list, it must also name
 * every repo of the original set and of earlier batches, every candidate an earlier draw
 * read, and every repo an earlier draw excluded (a repo once read for a fix stays read).
 */
export function drawCrossCheck(
  draw: DrawFile,
  repos: readonly EvalRepo[],
  draws: readonly DrawFile[] = [],
): string[] {
  const pins = new Map<string, Examined>();
  for (const stratum of draw.strata) {
    for (const e of stratum.examined) if (e.verdict === "pinned") pins.set(nameKey(e.repo), e);
  }
  const problems: string[] = [];
  if (draw.exclude) {
    const excluded = excludedKeys(draw);
    const missing = (name: string, what: string): void => {
      if (!excluded.has(nameKey(name))) problems.push(`${name} is ${what}, but not excluded`);
    };
    for (const repo of repos) {
      if (repo.heldOut !== undefined && repo.heldOut >= draw.batch) continue;
      const what = repo.heldOut === undefined ? "in the original set" : `in batch ${repo.heldOut}`;
      missing(`${repo.owner}/${repo.name}`, what);
    }
    for (const earlier of draws) {
      if (earlier.batch >= draw.batch) continue;
      for (const stratum of earlier.strata) {
        for (const e of stratum.examined) missing(e.repo, `read for batch ${earlier.batch}`);
      }
      for (const e of earlier.exclude ?? [])
        missing(e.repo, `excluded from batch ${earlier.batch}`);
    }
  }
  for (const repo of repos) {
    if (repo.heldOut !== draw.batch) continue;
    const name = `${repo.owner}/${repo.name}`;
    const pin = pins.get(nameKey(name));
    if (!pin) problems.push(`${name} is in batch ${draw.batch}, but its draw didn't pin it`);
    else if (pin.sha !== repo.sha) {
      problems.push(`${name}: the draw pinned ${pin.sha ?? "nothing"}, repos.json ${repo.sha}`);
    }
  }
  return problems.sort(compareStrings);
}
