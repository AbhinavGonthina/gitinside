# Evaluation: defensible numbers

GitInside's numbers must survive an interviewer asking "how did you measure that?" Rule zero: **report exactly what was measured, with method and limitations. Never inflate, round up, or cherry-pick.** Decisions: D3.4, D10.2, D10.3, ADR-0008.

## 1. Cross-service accuracy (M3)

**Question:** of the cross-service HTTP edges GitInside reports, how many are real (precision)? Of the real ones, how many does it find (recall)?

**Repos:** 5 public full-stack TypeScript repos with permissive licenses, within the 20k-file limit, covering different shapes:
- A Next.js app with its own API routes.
- A Next.js + Express (or similar) monorepo.
- A React SPA + Express backend in one repo.
- A repo using axios instances with `baseURL`.
- A repo with env-based API URLs.

Each is pinned by commit SHA in `eval/repos.json`.

**Ground truth format** (`eval/labels/<owner>__<repo>.json`):
```json
{
  "repo": "owner/name",
  "sha": "<40-char sha>",
  "labeler": "claude-draft",
  "reviewedBy": null,
  "edges": [
    {
      "callSite": { "file": "apps/web/lib/api.ts", "line": 14 },
      "method": "POST",
      "target": { "file": "apps/api/src/routes/orders.ts", "line": 42, "route": "POST /api/orders" },
      "notes": "wrapper placeOrder()"
    },
    {
      "callSite": { "file": "apps/web/app/blog/page.tsx", "line": 9 },
      "method": "GET",
      "target": null,
      "notes": "CMS on another host; correct answer is unresolved/external"
    }
  ]
}
```

**Labeling method** (D10.3):
1. Labels are drafted by reading the code: find every outbound HTTP call site (grep `fetch(`, `axios`, client wrappers) and trace it by hand to its route.
2. The labeler must not look at analyzer output while labeling. Label files are committed before the first scoring run, so history shows they came first.
3. Abhinav reviews a random 20% of call sites. The sample is chosen by a seeded shuffle (seed = the date the review issue is opened) and listed in the issue.
4. Disagreements are resolved in the label file, with a `notes` entry, and summarized in the report.
5. Until review is complete, reports are headed **"Pending owner review"**.

**Scoring** (`pnpm eval`):
- **Matching:** a predicted `http` edge matches a label when the call site (file + line) and target route (method + path) agree.
- **True positive:** predicted target equals the labeled target.
- **False positive:** predicted target is wrong, or a route was predicted where the label says none (`target: null`).
- **False negative:** a labeled target that was never predicted (an unresolved prediction for a labeled real target counts here).
- **Unresolved predictions** for `target: null` labels count as correct abstentions and are reported separately, not inside precision.
- Precision and recall are reported **overall, per repo, and per confidence level** (exact / pattern / heuristic).

**Report:** `eval/results/<YYYY-MM-DD>-<analyzerVersion>.md`, committed, containing:
- Repos and SHAs, the analyzer version, and machine specs.
- A counts table with precision and recall.
- Every false positive and false negative with file:line.
- Limitations.

`pnpm eval` must reproduce a committed report byte-for-byte from pinned inputs.

**After M3:** any analyzer change states its eval delta in the commit body.

## 2. Benchmarks

**Analysis time (M1 baseline, M6 incremental):**
- **Repo:** one large public TS monorepo under 20k source files, pinned SHA, recorded in `bench/repos.json`.
- **Measured:** wall-clock time of `analyze` (median of 5 runs after 1 warm-up), peak RSS, and time per pipeline stage.
- **Incremental:** apply the diff of 10 consecutive real commits one at a time and measure re-analysis time vs. a full run. Report the median speedup.
- **Machines:** the Oracle Always Free VM (production) and Abhinav's dev machine. Each is labeled with CPU, RAM, OS, and Node version.

**Rendering (M4b):**
- A synthetic and a real graph at 500 / 1,000 / 2,000 visible nodes.
- Playwright drives pan and zoom for 10 s; fps comes from `requestAnimationFrame` deltas (median and p5).
- Target: ≥ 60fps median at 2,000 nodes.

**Output:** `bench/results/<YYYY-MM-DD>-<name>.md` with raw numbers (JSON alongside), committed.

## 3. PR backtesting (M7)

**Question:** on real merged PRs, how often would GitInside have flagged a broken cross-service connection, and were those real?

**Method:**
1. Pick about 8 public repos with separate frontend and backend code, pinned in `eval/backtest/repos.json` with a date window.
2. For every merged PR in the window: analyze the base commit and the merge commit (incrementally), run `diff`, and record broken edges.
3. **Follow-up:** within the next 30 days of commits, was the break fixed (target restored, or the call removed or changed)? Record the fixing commit.
4. **Classification:** for every flagged break, a human-readable judgment (true break / false positive / unclear) with a reason. Claude drafts; the report states who classified and what was reviewed by Abhinav.
5. **Report** (`eval/backtest/results/<date>.md`): PRs scanned, PRs flagged, breaks flagged, true/false/unclear counts, fixed-later counts with links, and limitations (e.g. a "fix" might be coincidental).

**Never claim** "caught N bugs" unless each is classified as a true break with evidence. Phrase claims exactly as measured, for example: "flagged 23 broken connections across 1,140 merged PRs; 17 were confirmed real, and 12 of those were fixed in a later commit."
