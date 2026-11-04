/**
 * `pnpm --filter @gitinside/eval draw <status|snapshot> <batch>` (draw.ts):
 * - `status` prints where each stratum's walk stands: the next repo to read, or done.
 * - `snapshot` fetches the whole candidate pool of every stratum that has none yet with
 *   `gh api search/repositories` and writes it into `eval/draws/batch-<batch>.json`. A
 *   recorded pool is never replaced, so a draw can't be re-rolled by fetching again. Run
 *   `npx prettier --write` on the file afterwards.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPool, PAGE_SIZE, parseDrawFile, walkState, type SearchPage } from "./draw.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Today's local date as YYYY-MM-DD, the day a pool was fetched. */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One page of a repository search, through the signed-in `gh`. */
function searchPage(query: string, page: number): Promise<SearchPage> {
  const args = ["api", "-X", "GET", "search/repositories", "-f", `q=${query}`];
  args.push("-f", `per_page=${PAGE_SIZE}`, "-f", `page=${page}`);
  args.push("-f", "sort=stars", "-f", "order=desc");
  const text = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return Promise.resolve(JSON.parse(text) as SearchPage);
}

async function main(): Promise<void> {
  const [command, batch] = process.argv.slice(2);
  if ((command !== "status" && command !== "snapshot") || !/^\d+$/.test(batch ?? "")) {
    throw new Error("usage: draw <status|snapshot> <batch>");
  }
  const name = `batch-${batch ?? ""}.json`;
  const path = join(root, "draws", name);
  const draw = parseDrawFile(`draws/${name}`, readFileSync(path, "utf8"));
  if (command === "snapshot") {
    let changed = false;
    for (const stratum of draw.strata) {
      if (stratum.pool) {
        process.stdout.write(`${stratum.name}: pool already recorded, kept\n`);
        continue;
      }
      stratum.pool = await collectPool((page) => searchPage(stratum.query, page), today());
      changed = true;
      process.stdout.write(`${stratum.name}: ${stratum.pool.total} repos\n`);
    }
    if (changed) {
      parseDrawFile(`draws/${name}`, JSON.stringify(draw));
      writeFileSync(path, `${JSON.stringify(draw, null, 2)}\n`);
    }
    return;
  }
  for (const stratum of draw.strata) {
    const walk = walkState(draw, stratum);
    const line =
      walk.state === "no-pool"
        ? "no pool yet (run `draw snapshot`)"
        : walk.state === "next"
          ? `next ${walk.repo} (${walk.pinned}/${draw.perStratum} pinned, ${walk.examined} read)`
          : `done: ${walk.pinned}/${draw.perStratum} pinned, ${walk.examined} read${walk.exhausted ? ", pool exhausted" : ""}`;
    process.stdout.write(`${stratum.name}: ${line}\n`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
