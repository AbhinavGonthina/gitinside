# Backtest: is "0 broken edges in 926 PRs" a blind spot? (M7.2d)

The backtest replay (M7.2c, ADR-0216) diffed all 926 pinned PRs of 7 repos and `detectBroken` flagged nothing, though the diffs removed 2,785 edges. This note rebuilds a sample of those diffs and explains every removed edge whose source survived the PR while its target didn't. It changes no committed result.

**Answer:** the zero is partly a blind spot. In the sample, 77 of 78 such edges really went away with the code that used them, but one PR, `getmaxun/maxun#1157`, merged a real break that `detectBroken` can't see: it emptied `DocumentInterpreter.ts` while four files still imported the class and called five of its static methods. A direct push fixed it 55 minutes later. The detector documents this gap ("calls to removed functions": an unresolved call makes no node, and the import edge survives because the file still exists). No request→route edge in the sample should have been flagged.

## Method

- **Code:** GitInside `03a5d0b`, analyzer 0.2.0 (the same analysis code as every raw file, ADR-0216's M7.2c3 amendment), on the laptop, from the M7.2a clones in `eval/.repos/backtest/` with the replay's fact cache. Scratch scripts under `eval/dist/` (gitignored): `m72d-sample.mjs` (rebuild and audit), `m72d-routes.mjs` (stratum B), `m72d-sum.mjs`, `m72d-routegrep.mjs`, `m72d-emptied.mjs`.
- **Stratum A, seeded and weighted:** for each repo, its PRs that removed at least one edge (219 of 926), sampled without replacement with weight = edges removed (Efraimidis–Spirakis keys from `mulberry32(hashSeed("M7.2d/2026-11-07/<owner>/<name>"))`), 4 per repo (cal.diy has only 2). 26 PRs.
- **Stratum B, every PR that deletes a route file:** PRs whose tree diff (renames counted as delete + add) deletes a non-test `.ts/.js(x)` file on a route-defining path (`route.*`, `pages/api/`, `app/api/`, `routes/`, `endpoints/`, `controllers/`, `*.controller.*`, `*.route(s).*`, `*.router.*`). 13 PRs (12 dub.link, 1 anything-llm already in A). This stratum is here because A alone removed only 8 request→route edges.
- **Per PR:** analyze base and merge commit, `diffGraphs` with both trees' text (as the replay does), and check the summary equals the raw file's: **38 of 38 equal, 0 broken edges**. Then classify every removed edge by its source's and target's fate in head (kept, renamed by the diff, removed). The ones `detectBroken` considers are those whose source survives and whose target is removed or moved. For each of these, check:
  1. whether head has an unresolved edge of the same kind from that source (the head evidence `detectBroken` re-resolves);
  2. whether head's source file still spells the target's name (a symbol's last name, a file's basename, a route's path), read from the head tree;
  3. for request→route edges, where the request text went (same source, another source, gone).
- **Removed routes:** grep each head tree for the static part of each removed route's path, so a caller the analyzer never resolved in base (and so never had an edge to lose) is found too.
- **Census:** every one of the 926 PRs' tree diffs for a source file turned into the empty blob (the pattern below).

## Sample

38 PRs, 1,028 removed edges (37% of 2,785), 10 removed request→route edges, 20 removed routes.

| Repo | PR | Stratum | Edges removed | `http`→route removed | Routes removed | Source kept, target gone | Head still names target | Broken |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `Mintplex-Labs/anything-llm` | #5856 | A | 10 | 0 | 0 | 0 | 0 | 0 |
| `Mintplex-Labs/anything-llm` | #6027 | A | 12 | 0 | 0 | 1 | 0 | 0 |
| `Mintplex-Labs/anything-llm` | #6165 | A | 5 | 1 | 1 | 1 | 0 | 0 |
| `Mintplex-Labs/anything-llm` | #6226 | A+B | 90 | 2 | 1 | 14 | 2 | 0 |
| `calcom/cal.diy` | #29724 | A | 4 | 0 | 0 | 0 | 0 | 0 |
| `calcom/cal.diy` | #30084 | A | 3 | 0 | 0 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4047 | B | 47 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4112 | B | 1 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4130 | B | 48 | 0 | 2 | 6 | 0 | 0 |
| `dubinc/dub.link` | #4148 | B | 17 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4187 | B | 41 | 1 | 1 | 2 | 0 | 0 |
| `dubinc/dub.link` | #4195 | B | 23 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4221 | A | 45 | 0 | 0 | 7 | 1 | 0 |
| `dubinc/dub.link` | #4241 | B | 14 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4335 | B | 64 | 0 | 5 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4350 | B | 16 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4378 | A | 7 | 0 | 0 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4394 | A | 134 | 5 | 0 | 3 | 0 | 0 |
| `dubinc/dub.link` | #4448 | B | 9 | 1 | 1 | 1 | 0 | 0 |
| `dubinc/dub.link` | #4451 | B | 29 | 0 | 1 | 0 | 0 | 0 |
| `dubinc/dub.link` | #4456 | A | 24 | 0 | 0 | 2 | 0 | 0 |
| `dubinc/dub.link` | #4477 | B | 17 | 0 | 2 | 0 | 0 | 0 |
| `getmaxun/maxun` | #1135 | A | 3 | 0 | 0 | 0 | 0 | 0 |
| `getmaxun/maxun` | #1157 | A | 100 | 0 | 0 | 5 | 5 | 0 |
| `getmaxun/maxun` | #1189 | A | 9 | 0 | 0 | 0 | 0 | 0 |
| `getmaxun/maxun` | #1213 | A | 15 | 0 | 0 | 4 | 0 | 0 |
| `hoangsonww/Claude-Code-Agent-Monitor` | #226 | A | 31 | 0 | 0 | 0 | 0 | 0 |
| `hoangsonww/Claude-Code-Agent-Monitor` | #260 | A | 5 | 0 | 0 | 0 | 0 | 0 |
| `hoangsonww/Claude-Code-Agent-Monitor` | #269 | A | 45 | 0 | 0 | 7 | 0 | 0 |
| `hoangsonww/Claude-Code-Agent-Monitor` | #342 | A | 21 | 0 | 0 | 3 | 0 | 0 |
| `seerr-team/seerr` | #3142 | A | 1 | 0 | 0 | 0 | 0 | 0 |
| `seerr-team/seerr` | #3366 | A | 4 | 0 | 0 | 0 | 0 | 0 |
| `seerr-team/seerr` | #3367 | A | 26 | 0 | 0 | 3 | 0 | 0 |
| `seerr-team/seerr` | #3449 | A | 1 | 0 | 0 | 0 | 0 | 0 |
| `trycompai/comp` | #3361 | A | 27 | 0 | 0 | 7 | 0 | 0 |
| `trycompai/comp` | #3398 | A | 9 | 0 | 0 | 1 | 0 | 0 |
| `trycompai/comp` | #3417 | A | 56 | 0 | 0 | 11 | 3 | 0 |
| `trycompai/comp` | #3459 | A | 15 | 0 | 0 | 0 | 0 | 0 |

Removed edges by kind and fate (source, target): `calls` 188 kept/kept, 46 kept/removed, 2 renamed/removed, 171 removed/kept, 123 removed/removed, 3 removed/renamed; `imports` 76 kept/kept, 27 kept/removed, 2 renamed/kept, 222 removed/kept, 24 removed/removed; `http` 1 kept/kept, 3 kept/removed, 6 removed/kept, 15 kept/unresolved, 6 removed/unresolved; `handles` 3 removed/kept, 17 removed/removed, 1 removed/renamed; `reads` 12 kept/kept, 31 removed/kept; `writes` 6 kept/kept, 30 removed/kept; `external_call` 9 kept/kept, 3 removed/kept, 1 removed/removed. Most removed edges went with their source (deleted code), or both ends survived and the call itself was deleted or became unresolved. Neither can be a broken connection.

## The 78 edges whose source survived and target didn't

None had head evidence: **0 of 78** have an unresolved edge of the same kind from the surviving source in head, so `detectBroken` had nothing to re-resolve in any of them.

- **Request→route, 3 (anything-llm #6165, dub.link #4187, #4448):** in all three the PR changed the caller together with the route. #6165 moved `DELETE /api/workspace/prompt-history/:id` under `/workspace/:workspaceId/…`, and `PromptHistory.delete` now calls the new path. #4187 moved `POST /api/embed/referrals/submissions` to `/api/embed/referrals/bounties/:bountyId/submissions`, and the form now calls that. #4448 removed `GET …/groups/:groupIdOrSlug` and the sheet's `useSWR` call to it. The other 7 removed request→route edges went with their source (6) or stopped being made while the route stayed (dub.link #4394's `AddHostnameForm` no longer calls `PATCH /api/workspaces/{}`, and other components still do).
- **`calls`, 48:** 38 head sources no longer spell the target's name, so the call went with it. 10 still do:
  - **maxun #1157, 5: a real break, below.**
  - comp #3417, 3: `applyProfileResult` moved to another class, and the method now calls `this.stepRunner.applyProfileResult(…)`.
  - anything-llm #6226, 2: rename detection matched the removed Docker Model Runner provider's `compressMessages` to the `llmman` provider's, whose `this.assertModelContextLimits()` and `this.constructPrompt()` are that class's own methods.
- **`imports`, 27:** 26 head importers no longer spell the file, so the import was dropped. 1 (dub.link #4221) is a false text match: `campaign-editor.tsx` imports `@dub/utils`, not the deleted `./utils`.

## Removed routes

20 routes were removed in 14 sampled PRs. 18 have no caller anywhere in head: the static part of their path appears in no `.ts/.js(x)` file. 15 of these are `cron/…` and `e2e/…` routes, which schedulers and tests outside the repo call. The other 3 lost their callers in the same PR: anything-llm's prompt-history and Docker Model Runner routes, and dub.link's embed submissions route (above). The 2 routes with text hits aren't breaks either. dub.link #4350 renamed `[discountCodeId]` to `[idOrCode]`, and `delete-discount-code-modal.tsx`'s call to `/api/discount-codes/<id>` still matches the new route. #4448's static prefix (`/partner-profile/programs`) appears only in other routes, and nothing calls `…/groups/…`. So no removed route was left with a live caller that the analyzer never resolved.

## The miss: `getmaxun/maxun#1157`

- **What merged:** PR #1157 "fix: enhance document llm post processing" (3 commits, merge commit `c5e849e`, 2026-08-03 11:04 UTC) turned `server/src/workflow-management/classes/DocumentInterpreter.ts` (1,571 lines in base, holding `export class DocumentInterpreter`) into the empty blob. In head, four files still import `DocumentInterpreter` from it and call its static methods: `createDocumentParseRobotRecord.ts:27` and `executeDocumentParseRun.ts:24` (`parse`), `createDocumentRobotRecord.ts:47` and `:50` (`extractText`, `generateExtractionSchema`), and `executeDocumentRun.ts:28` (`extractData`). Base's file held one NUL byte, so git calls it binary.
- **Fix:** `9262631` "fix: null byte corruption", pushed straight to `develop` at 17:29 +0530 (55 minutes after the merge), restored the file. Four PRs (#1149, #1161, #1166, #1172) merged in between, onto the broken tree. The fix isn't in any pinned PR's base..merge range, so it is no PR's change.
- **Why `detectBroken` missed it:** the five `calls` edges lost their targets (the symbols are gone), but head's calls resolve to nothing, and an unresolved call makes no node, so there's nothing to re-resolve. The `imports` edges to `DocumentInterpreter.ts` survive, because the file still exists. This is the documented "calls to removed functions" gap. The only head evidence is an import naming `DocumentInterpreter`, which the file no longer exports.
- **Census:** among all 926 PRs, #1157 is the only one whose merge commit empties a source file. A missing named import has more causes than an emptied file, though (a deleted export, a renamed export), and the census doesn't find those. The re-run after the fix will.

## What follows

- **M7.2e:** make the analyzer record, on an `imports` edge's site, the imported names the target file doesn't export. `detectBroken` then flags a base `calls` (or `imports`) edge whose target symbol is gone while head still imports its name from the same file. Tests red first, with a fixture that empties or un-exports a file, plus golden, ADR, and eval delta.
- **M7.2f:** re-run the replay for all 7 repos with that analyzer (one analyzer for every file), expecting maxun #1157 among the flagged breaks.
- **M7.3:** look for a fix past the PRs too. #1157's fix was a direct push, not a PR.
