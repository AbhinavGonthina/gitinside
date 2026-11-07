/**
 * `pnpm --filter @gitinside/eval backtest:prs [owner/name …]`: pin the PRs the backtest
 * replays (prs.ts, ADR-0215). For each repo in `eval/backtest/repos.json` (or only those
 * named), clone its branch history into `eval/.repos/backtest/` (blobless, never checked out),
 * ask GitHub for the PRs merged in the window, and write
 * `eval/backtest/prs/<owner>__<name>.json`. A written list is never replaced, so the PRs
 * can't be re-picked after a replay; delete the file in a commit that says why to list again.
 * Run `npx prettier --write` on new files afterwards.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacktestReposFile } from "./format.js";
import { ensureClone, gitView } from "./git.js";
import { pullFacts, pullMessages, searchMerged, searchQuery, type GitHubApi } from "./github.js";
import { parsePrsFile, prsCrossCheck, prsFileName, selectPrs, type PrsFile } from "./prs.js";

const EVAL = fileURLToPath(new URL("../../", import.meta.url));
const PRS = join(EVAL, "backtest", "prs");

const api: GitHubApi = (path) =>
  JSON.parse(
    execFileSync("gh", ["api", "-X", "GET", path], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }),
  );

/** Today's local date as YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function main(): void {
  const pins = parseBacktestReposFile(
    "backtest/repos.json",
    readFileSync(join(EVAL, "backtest", "repos.json"), "utf8"),
  );
  const asked = process.argv.slice(2).map((a) => a.toLowerCase());
  const repos = pins.repos.filter(
    (r) => asked.length === 0 || asked.includes(`${r.owner}/${r.name}`.toLowerCase()),
  );
  if (repos.length < asked.length)
    throw new Error(`not every repo named is pinned: ${asked.join(", ")}`);
  mkdirSync(PRS, { recursive: true });
  for (const repo of repos) {
    const name = `${repo.owner}/${repo.name}`;
    const path = join(PRS, prsFileName(repo));
    if (existsSync(path)) {
      process.stdout.write(`${name}: already listed in backtest/prs/${prsFileName(repo)}\n`);
      continue;
    }
    const dir = join(EVAL, ".repos", "backtest", `${repo.owner}__${repo.name}`);
    process.stderr.write(`${name}: cloning or updating ${repo.branch}'s history\n`);
    ensureClone(dir, repo);
    const search = searchQuery(repo, pins.window);
    const searched = searchMerged(api, search);
    process.stderr.write(`${name}: ${searched.length} search results\n`);
    const file: PrsFile = {
      repo: name,
      listed: today(),
      branch: repo.branch,
      startSha: repo.startSha,
      endSha: repo.endSha,
      search,
      ...selectPrs(searched, repo, pins, {
        facts: (pr) => pullFacts(api, repo, pr),
        messages: (number) => pullMessages(api, repo, number),
        git: gitView(dir),
      }),
    };
    const shown = `backtest/prs/${prsFileName(repo)}`;
    parsePrsFile(shown, JSON.stringify(file));
    const problems = prsCrossCheck(file, pins, prsFileName(repo));
    if (problems.length > 0) throw new Error(`${shown}:\n  - ${problems.join("\n  - ")}`);
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    process.stdout.write(
      `${name}: ${file.found} merged in the window, ${file.prs.length} pinned, ${file.excluded.length} excluded, ${file.overCap.length} over the cap\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
