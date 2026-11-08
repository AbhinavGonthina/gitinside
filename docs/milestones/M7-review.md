# M7 review: PR backtesting

**Status: final (M7.6z, 2026-11-07; drafted in M7.6a).** The fresh-eyes review's findings were fixed in M7.6b–d (outcomes below). M7.6z re-ran the checks, all green, and tagged `m7`. · **Range:** `m6..4efdb03` (M7.1 `cb8a7d0` to M7.5 `9c602fa`, with M5.14b4 and the M7.2c2a web fix in between), then the fixes M7.6b–d · **Checked at:** `4efdb03` and `da233b7` (M7.6z, tagged)

## What was built

M7 answers the question the PR bot (M8) will be judged on: run on real merged PRs, does the broken-connection detector find real breaks, and were they fixed later? Everything is a script over committed files, so each number in the report can be rebuilt from the repo.

| Piece | Where | What it does |
|---|---|---|
| Repo pins | `eval/backtest/repos.json` (ADR-0214) | One window (merged 2026-07-01 to 2026-09-30), a 30-day follow-up, a 300-PR cap per repo, five selection rules measured before any replay, and every rejected candidate with the rule it failed: 7 pinned of 65 |
| PR lists | `eval/backtest/prs/`, `prs.ts` (ADR-0215) | Every PR merged in the window, in merge order, each replayed with a base read from how GitHub merged it (merge, squash, rebase), excluded with a reason, or past the cap; written once, never replaced |
| Replay | `replay.ts`, `replayCli.ts`, `.github/workflows/backtest-replay.yml` (ADR-0216) | Analyzes base and merge commit of each PR from a clone's worktrees with a shared fact cache, diffs them, keeps each broken edge whole; one job per repo on GitHub's runners; a restart resumes only the same run (same commit, analyzer, machine) |
| Missed-break check | `eval/results/2026-11-backtest-zero-check.md` (M7.2d) | The first replay flagged 0 breaks. 38 diffs rebuilt by hand, 78 removed edges explained one by one: one real break missed (maxun #1157) |
| Detector rule | `packages/analyzer/src/imports.ts` `missingExports`, `packages/diff/src/broken.ts` `stillImported` (ADR-0087's M7.2e amendment) | An import site records the names it asks for that the target file doesn't export; a call to a removed symbol whose name the caller still imports is `TARGET_REMOVED` |
| Follow-up | `followUp.ts`, `git.ts` `laterCommits` (ADR-0217) | Diffs each flagged PR's base with every later commit up to `endSha` (direct pushes included); a break is fixed at the first commit the same detector no longer flags; first rebuilds the PR's breaks and refuses on any mismatch |
| Classification | `eval/backtest/classified/`, `classify.ts` (ADR-0218) | A hand-written verdict per break (true, false positive, unclear) with a reason, permalink evidence, a judgment of its fix, and a per-break reviewer (`null` = draft) |
| Report | `report.ts`, `eval/backtest/results/2026-11-07.md`, `eval/backtest/limitations.md` (ADR-0219) | Rendered from the committed files alone, dated by them, checked byte for byte (`--check` and a unit test) |

## Results (exactly as measured)

- **The backtest** (`eval/backtest/results/2026-11-07.md`): 926 merged PRs of 7 repos replayed (1,004 merged in the window; 1 excluded, 77 past the cap), 0 failed. **5 broken edges in 1 PR** (maxun #1157), all in-service `calls`; **0 cross-service (`http`) edges flagged**. Verdicts: 5 true, drafted by Claude, **0 of 5 reviewed by Abhinav**. All 5 fixed by a direct push (`9262631`) 54 min 46 s after the merge, judged a real fix.
- **Not blind:** the rule that flags #1157 was written after the M7.2d hand check found it. The report says so first in its Limitations.
- **Tests (local at `4efdb03`, uncached, `npx turbo run test --force --concurrency=1 --continue`, 15 of 15 tasks, 0 cached):** 4,522 passed, 4 skipped. Analyzer 1,442, viewer 1,116, web 693, worker 641 (+1 skipped), eval 198, db 154 (+3 skipped), diff 147, bench 95, schema 36. Nothing failed or was rerun.
- **Coverage (CI run 42383954316 on `4efdb03`, all jobs green, visual and web E2E included):** analyzer 97.66% lines, 91.15% branches (target 85%; `imports.ts` 98.97% / 89.58%); diff 98.81% / 93.1% (`broken.ts` 97.61% / 92.6%). Every other package is at or above 86.73% lines (target 70%): viewer 99.3%, db 99.2%, web 98.08%, worker 95.67%, schema 94.8%, bench 100%, **eval 86.73%** (99.66% at `m6`). The drop is the four backtest CLIs at 0% (`listCli.ts`, `replayCli.ts`, `followUpCli.ts`, `reportCli.ts`, 352 lines), which, unlike eval's older CLIs, aren't in the coverage config's thin-CLI list or tested (F9). The modules under them: `prs.ts` 100%, `classify.ts` 100%, `report.ts` 98.4%, `replay.ts` 96.82%, `followUp.ts` 96.27%, `git.ts` 76.06% (its clone and fetch).
- **Checks:** `backtest:report --check` and `pnpm eval --check` (`eval/results/2026-11-07-0.2.0.md`) reproduced byte for byte; `validate`: 7 backtest repos, 926 PRs, 926 replayed, 1 flagged PR followed up, 5 breaks classified (0 reviewed).

**Re-check after the fixes (M7.6z, at `da233b7`):**
- **Tests (local, uncached, `npx turbo run test --force --concurrency=1 --continue`, 15 of 15 tasks, 0 cached):** 4,550 passed, 4 skipped. Analyzer 1,442, viewer 1,116, web 693, worker 641 (+1 skipped), eval 226 (+28 from M7.6b–d), db 154 (+3 skipped), diff 147, bench 95, schema 36. Nothing failed or was rerun.
- **Coverage (CI run 42390457243 on `da233b7`, all jobs green: check, worker-image, visual, web-e2e, deploy):** analyzer 97.66% lines, 91.16% branches (`imports.ts` 98.97% / 89.58%); diff 98.81% / 93.1% (`broken.ts` 97.61% / 92.6%); **eval 98.5% / 93.67%** (86.73% at the draft; `cliShared.ts` 100% / 96.96%); viewer 99.3%, db 99.2%, web 98.08%, worker 95.67%, schema 94.8%, bench 100%.
- **Checks:** `pnpm eval --check` and `backtest:report --check` reproduced byte for byte; `validate` unchanged (7 repos, 926 PRs replayed, 1 followed up, 5 breaks classified, 0 reviewed). The backtest's numbers didn't move: the fixes changed guards, docs, and the follow-up's rule, and maxun's re-run under the new rule gave the same fix.

## Key decisions and trade-offs

- **Rules before results** (ADR-0214): repos were picked by five recorded rules measured at `startSha`, before any PR was replayed, and the bar (≥ 20 resolved requests to routes from app code) wasn't lowered when only 7 passed. The report says "7, fewer than the ~8 planned" rather than padding the set with repos that can't flag anything.
- **Write once** (ADR-0215): PR lists and pins are never replaced, so nobody can re-pick PRs after seeing results.
- **One analyzer per result set** (ADR-0216): a replay resumes only the same gitinside commit, analyzer, and machine. When M7.2e changed the detector, all 7 repos were replayed again (cal.diy too, though nothing changed there) so every number comes from one commit (`a3622e1`).
- **The same detector judges the fix** (ADR-0217): "fixed" means the rule that flagged the break no longer does, diffed from the PR's base, so the follow-up can't be looser or stricter than the flag.
- **Drafts are labeled as drafts** (ADR-0218, ADR-0219): verdicts carry a per-break reviewer, and the report counts reviewed and drafted verdicts apart. Precision "from drafts" is printed next to "over reviewed: n/a".

## Hardest problem: what does a zero mean?

The first full replay (M7.2c3) found 0 broken edges in 926 PRs with 2,785 edges removed. A zero could mean the repos were careful, or that the detector was blind. The code can't tell those apart, so M7.2d checked by hand: a seeded sample weighted toward PRs that removed the most edges, plus every PR that deleted a route file (38 diffs), and an explanation for each of the 78 removed edges whose caller survived. 77 went away with the code that used them; one didn't. maxun #1157 emptied `DocumentInterpreter.ts` while four files still called five of its static methods. The detector couldn't see it because a call to nothing makes no graph node, and the import edge survives along with the empty file.

The fix (M7.2e) adds evidence instead of a guess: the analyzer records on each import site the names the target file doesn't export, so the diff can say "the caller still imports a name whose function was removed". The CommonJS case showed why surveying matters: the first rebuild claimed a file imported a missing `default` from a module mixing ES `import`s with `module.exports`, which bundlers accept. Such files are now skipped, and a survey of all 7 repos at their window's end found missing names on 5 of 51,511 import sites, all real (harmless) type errors. The re-run then flagged exactly #1157's 5 calls and nothing else.

The cost is honesty: the backtest is no longer blind, and the report says that before anything else.

## What's still weak

- **No cross-service break was found.** The PR bot is mainly about request→route breaks, and this backtest has no measured example of one. All 5 flags are in-service calls from one PR with one cause.
- **Recall isn't measured.** 38 of 926 PRs were checked by hand; the rest could hide misses. Known blind spots: a function that stays but stops being exported, a symbol exported under an alias (F6; now listed in `detectBroken`'s "Doesn't handle" and the report's limitations, not fixed), changed contracts on kept connections, and anything the analyzer can't resolve into an edge (tRPC, GraphQL, unsupported backends).
- **0 of 5 verdicts reviewed.** The same model family wrote the detector and the verdicts.
- **7 repos, not ~8**, chosen from a hand-started list.
- **Stacked PRs in the lists** (F8): dub.link #4246 and #4295 stay in the replay with their child's merge commit, so each diff is two PRs. The report names them; the lists are written once and never rewritten, and `classifyPr` now excludes both shapes in future lists.
- **The fix's time is the committer's** on the branch's first-parent line (F7 fixed): a fix that landed through a long-lived branch is timed when its commit was made, not when it reached `endSha`'s line.

## Fresh-eyes review

A subagent with no prior context reviewed `m6..HEAD` read-only against SPEC.md, TESTING.md, SECURITY.md, and EVALUATION.md. It found nothing high-severity.

It confirmed the following:
- **Report numbers:** 926 `diffed` outcomes (31/300/60/90/202/97/146), one `"broken": 5` (maxun), 1,004 merged in the window.
- **Security:** the workflow passes inputs through env, `persist-credentials: false`, `contents: read`, installs only gitinside's own dependencies, and never runs a replayed repo's code; SHAs are regex-checked before worktrees open, and worktrees open without hooks.
- **Determinism:** the report is dated by its inputs and sorted with `compareStrings`.
- **Replay and resume:** cache eviction, `cannotResume`, the limit and resume arithmetic, and `rawCrossCheck` are correct.
- **`missingExports`:** it only errs toward missing a break; unknown exports (CommonJS, `export =`, declaration files, unresolved `export *`) record nothing.
- **M5.14b4 and M7.2c2a:** no problems.

Findings marked "confirmed" were traced in the code or the data by the reviewer or in this task; "plausible" ones need a red test first.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| F7 | Medium (plausible; not in today's data) | `laterCommits` (`--ancestry-path --date-order`) includes side-branch commits, and the first one that stops flagging a break is the "fix", with its committer time as "after": a WIP commit that deletes the caller on a branch that later lands with the caller kept would count. `atEnd` catches it only if the break lasts to `endSha`. maxun's `9262631` is on `develop`'s first-parent line (checked: `eval/dist/m7-first-parent.mjs`) | **Fixed (M7.6b, `686d35c`, ADR-0217 amendment).** A break is `fixed` only at a commit on `endSha`'s first-parent line that holds the merge (`lineCommits`); an earlier side-branch hit is kept as `offLine` and never counted. A fixture `wip` branch (clears the break, re-breaks, then lands) was fixed at the WIP commit before, red first. maxun re-run (`ee7868a`): unchanged, `9262631` fixes all 5, `offLine` null |
| F8 | Medium → low (confirmed in data) | `classifyPr` reads any two-parent merge commit as `merge` with its first parent as base. The reviewer's case (a fast-forward whose head merges `main` into the branch, base then on the branch) occurs in 0 of the 439 merge-kind PRs. Checking every merge commit's subject found 2 others: dub.link #4246 and #4295 are stacked PRs GitHub marked merged when their child landed, so their "merge commit" is #4256's and #4300's. Their base is the branch's real previous state, so each diff is the PR plus its child, not the PR alone | **Fixed for future lists, documented for these (M7.6c, `dab1114`, ADR-0215 amendment).** `classifyPr` excludes a merge commit that isn't the PR's own (second parent ≠ `head.sha`, or a "Merge pull request #N" subject for another N) and a merge head the branch fast-forwarded to. `limitations.md` and the report name #4246 (`43d4cb7`, #4256's) and #4295 (`898c84f`, #4300's); the committed lists are unchanged |
| F3 | Low (confirmed) | `validate` doesn't check that a follow-up file's analyzer version equals its raw file's; only `followUpRepo` checks at run time, and the analyzer's version (0.2.0) didn't change across M7.2e's detector change anyway. The re-diff equality check is what actually guards | **Fixed (M7.6c).** `followUpCrossCheck` requires the raw file's analyzer version; test red first |
| F4 | Low (confirmed) | Nothing requires all raw files to come from one gitinside commit; a mix would render silently (all 7 are `a3622e1` today) | **Fixed (M7.6c, ADR-0216 amendment).** `backtestProblems` requires one gitinside commit across raw files; test red first |
| F5 | Low (confirmed) | `repos.json`'s `branch` reaches `git fetch … origin <branch>` (`git.ts:69`) unvalidated, with no `--end-of-options`; `format.ts` only requires it non-empty. Committed and reviewed, so exposure is low, but SECURITY.md asks for it | **Fixed (M7.6c).** `format.ts` requires a plain ref name (no leading `-`), and `git.ts` passes refs and SHAs after `--end-of-options`; tests red first |
| F1 | Low (docs, confirmed) | EVALUATION.md §3 step 2 says cal.diy was replayed on the dev laptop; M7.2f replaced that run with the workflow's | **Fixed (M7.6d, `91e0e6a`).** Step 2 says all 7 raw files come from the Backtest replay workflow (cal.diy's run line checked: a Linux runner) |
| F2 | Low (docs, confirmed) | EVALUATION.md §3 step 3 says "within the next 30 days of commits"; the code scans to `endSha` (30 days after the window, so 30–122 days after a merge), as the report says | **Fixed (M7.6d).** Step 3 says the follow-up runs to `endSha`, 30–122 days after a merge |
| F6 | Low (confirmed by reading) | `stillImported` looks for the symbol's declared name, so a symbol exported under an alias (`export { foo as bar }`, imported as `bar`) is missed when removed; not in `detectBroken`'s "Doesn't handle" list or the report's limitations | **Documented (M7.6d), not fixed.** Named in `detectBroken`'s "Doesn't handle" and `eval/backtest/limitations.md`; the backtest report regenerated. A miss only lowers recall, which isn't measured anyway |
| F9 | Low (found in this task) | The backtest CLIs are 0% covered and not in eval's thin-CLI exclusion list, so eval's coverage reads 86.73%. The smoke test also found their relative `--out` resolved from the repo root, though pnpm runs them in `eval/`, and the usage lines don't say so | **Fixed (M7.6d).** Argument handling moved to `cliShared.ts` (`namedRepos`, `parseLimit`, `outDir`, `ownFiles`; 19 tests, 100% lines), the four CLIs joined the thin-CLI exclusion with the reason, and the usage lines say a relative `--out` is resolved from the repo root. Eval coverage 98.5% lines on CI |
| S1 | Low (UX, smoke test) | The Mermaid summary labels removed methods without their class (`method parse - Removed`); a PR reader can't tell which `parse` | **Fixed (M8.6a).** A symbol is named after its enclosing symbols (`method DocumentInterpreter.parse - Removed`); a method renamed within its class says "Renamed from parse", moved to another class "Renamed from DocumentInterpreter.parse"; tests red first, mutation-checked |

## Smoke test

Run as a user would, on the laptop (Windows), with the built CLI, 2026-11-07.

**1. `gitinside diff 650bcad c5e849e --repo <maxun clone>`** (maxun #1157's base and merge):
- Exited 0, a 43,739-byte diff (SHA-256 `a493ef6eeb2f…`): nodes 0 added, 66 removed, 2 modified, 2 updated, 2 renamed; edges 0 added, 100 removed, 0 modified, 7 updated, 2 renamed; **5 broken**, all `TARGET_REMOVED`, the same 5 calls as the report; no warnings.
- The same counts as the committed raw entry, which came from a Linux runner.
- `--format mermaid`: 5 dashed red "Broken: target removed" lines from the four callers to the 4 removed methods, plus the removed `external_call` to `api.anthropic.com` that the emptied file made. The methods are labeled without their class (S1).

**2. `pnpm --filter @gitinside/eval backtest:followup getmaxun/maxun --out dist/smoke-followup`** (at `c85a80a`):
- Rebuilt #1157's 5 breaks, matched them with the raw file, then analyzed 6 of the 473 later commits: 0 of 5 fixed at `fb4c6b5`, `9da8101`, `d91ecf0`, `079b9c1`, `4d16f21`, then 5 of 5 at `9262631`.
- The written file equals the committed `eval/backtest/followup/getmaxun__maxun.json` apart from its run line (`eval/dist/m7-compare-followup.mjs`).
- `--out` is resolved from the repo root, not from `eval/` where pnpm runs the script, so the file landed in a root `dist/` (gitignored). The usage line doesn't say which; folded into F9.

**3. Data checks for the review's findings** (scratch scripts under `eval/dist/`): every merge-kind PR's merge commit subject against "Merge pull request #N" (F8: 437 of 439 match, the 2 stacked PRs don't), and `9262631` on `develop`'s first-parent line at `endSha` (F7: yes).

## Interview questions

1. **Your backtest found 0 broken connections in 926 PRs. Why didn't you report that?**
   A zero is only good news if the detector could have seen a break. I checked by hand: a weighted sample of 38 diffs and every removed edge whose caller survived. That found one real break the detector couldn't see (an emptied file whose callers still imported it). I fixed the detector with new evidence, re-ran everything, and the report now says it isn't a blind test, because the rule came from seeing the data.

2. **How do you know a later commit "fixed" a break, rather than changing something unrelated?**
   The follow-up diffs the PR's base with each later commit, oldest first, and asks the same detector whether it still flags the break. The first commit where it doesn't is the candidate, along with how (restored, caller removed, call changed). That's mechanical, so each fix is also judged by hand with permalink evidence. Before scanning, the tool rebuilds the PR's own breaks and refuses if they differ from the replay, so the judge is the same analyzer that flagged it.

3. **Why can't you just use GitHub's `base.sha` as the "before" state of a PR?**
   It's the base branch's tip when the PR was last updated, not when it merged. The base comes from the merge itself: a merge commit's first parent, a squash's parent, or for a rebase the commit below the PR's commits, found by matching the PR's commit messages on the branch. This review found a fourth shape: stacked PRs that GitHub marks merged when a child PR lands, whose "merge commit" is the child's.

4. **The replay ran on GitHub Actions runners with different CPUs. Doesn't that make the results inconsistent?**
   The results are graph diffs, which are deterministic: the same commit gives byte-identical graphs on any machine. Only run times would differ, and the report quotes none. What must not vary is the analyzer, so a replay resumes only the same gitinside commit, and all 7 raw files come from one commit. This review's smoke test reproduced #1157's counts on Windows.

5. **Precision is 100% (5/5). Is the detector precise?**
   That number is a count, not an estimate: 5 breaks from one PR with one cause, and the verdicts are drafts by the same model family that wrote the detector, with 0 reviewed by a human. The report prints it as "from drafts" next to "over reviewed: n/a". It also says no cross-service break was found, which is what the PR bot is mainly for.

Quiz yourself: open Claude Code and say "quiz me on M7".
