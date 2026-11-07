/**
 * The backtest's classification (docs/EVALUATION.md §3 step 4, ADR-0218): a human-readable
 * judgment of every break the replay flagged, kept in
 * `eval/backtest/classified/<owner>__<name>.json`, one file per follow-up file with a flagged PR.
 *
 * - **Per break:** a verdict (`true` break, `false` positive, or `unclear`), the reason in a
 *   sentence, and evidence as GitHub permalinks into the classified repo (a file at a 40-hex
 *   SHA, a commit, or a PR), so each judgment can be checked rather than trusted.
 * - **Per fix:** where the follow-up found a fixing commit, whether it really fixed the break
 *   (`real`), only made the detector stop flagging it for another reason (`coincidental`, ADR-0217's
 *   "Not handled"), or `unclear`, with why; `null` exactly when the follow-up found none.
 * - **Who:** the file names who drafted it (`classifiedBy`, the day in `drafted`), and each
 *   break says who reviewed it (`reviewedBy`, `null` while it's only a draft), so the report can
 *   state which verdicts are drafts and which Abhinav checked.
 *
 * Not handled: the verdict is a judgment, not a measurement; nothing here checks that the
 * evidence supports it, only that it names real places at fixed commits.
 */
import { z } from "zod";
import { parseWith } from "../format.js";
import type { FollowUpFile } from "./followUp.js";

/** What a flagged break turned out to be. */
export const VERDICTS = ["true", "false", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What a fixing commit turned out to be. */
export const FIX_VERDICTS = ["real", "coincidental", "unclear"] as const;
export type FixVerdict = (typeof FIX_VERDICTS)[number];

const why = z.string().trim().min(1);

const fixJudgmentSchema = z.object({ verdict: z.enum(FIX_VERDICTS), why }).strict();

const classifiedBreakSchema = z
  .object({
    /** The base edge that broke (`FollowedBreak.edge` in the follow-up file). */
    edge: z.string().min(1),
    verdict: z.enum(VERDICTS),
    why,
    /** Permalinks into the classified repo; checked by the file's refinement. */
    evidence: z.array(z.string()).min(1),
    /** The judgment of the follow-up's fixing commit, or `null` if it found none. */
    fix: fixJudgmentSchema.nullable(),
    /** The GitHub login that reviewed this verdict, or `null` while it's a draft. */
    reviewedBy: z.string().min(1).nullable(),
  })
  .strict();

export type ClassifiedBreak = z.infer<typeof classifiedBreakSchema>;

/** Escape `text` for use inside a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

/** Whether `url` is a permalink into `repo`: a file at a full SHA, a commit, or a PR. */
export function isPermalink(url: string, repo: string): boolean {
  const base = `^https://github\\.com/${escape(repo)}/`;
  return [
    new RegExp(`${base}blob/[0-9a-f]{40}/[^\\s#]+(#L\\d+(-L\\d+)?)?$`),
    new RegExp(`${base}commit/[0-9a-f]{40}$`),
    new RegExp(`${base}pull/\\d+$`),
  ].some((pattern) => pattern.test(url));
}

/** `eval/backtest/classified/<owner>__<name>.json`. */
export const classifiedFileSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"'),
    /** The gitinside commit of the follow-up file classified (its run line). */
    followUp: z.string().min(1),
    /** Who drafted the verdicts. */
    classifiedBy: z.string().trim().min(1),
    /** The day they were drafted. */
    drafted: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
    /** Every PR of the follow-up file, in its order, with each of its breaks. */
    prs: z.array(
      z
        .object({
          number: z.number().int().min(1),
          breaks: z.array(classifiedBreakSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((file, ctx) => {
    file.prs.forEach((pr, i) =>
      pr.breaks.forEach((b, j) =>
        b.evidence.forEach((url, k) => {
          if (isPermalink(url, file.repo)) return;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["prs", i, "breaks", j, "evidence", k],
            message: `must be a permalink into ${file.repo} (a file at a 40-hex SHA, a commit, or a PR)`,
          });
        }),
      ),
    );
  });

export type ClassifiedFile = z.infer<typeof classifiedFileSchema>;

/** Parse and validate the text of a classification file; `file` names it in errors. */
export function parseClassifiedFile(file: string, text: string): ClassifiedFile {
  return parseWith(classifiedFileSchema, file, text);
}

/**
 * Problems between a classification file and the follow-up file it classifies: another repo or
 * follow-up run, PRs or breaks that aren't exactly the follow-up's in order, or a fix judged
 * where none was found (or not judged where one was).
 */
export function classifyCrossCheck(file: ClassifiedFile, followUp: FollowUpFile): string[] {
  if (file.repo !== followUp.repo)
    return [`classifies ${file.repo}, but the follow-up file is ${followUp.repo}`];
  const problems: string[] = [];
  if (file.followUp !== followUp.run.gitinside) {
    problems.push(
      `classifies the follow-up at ${file.followUp}, the follow-up file's is ${followUp.run.gitinside}`,
    );
  }
  if (file.prs.length !== followUp.prs.length) {
    problems.push(
      `${file.prs.length} PRs classified, but the follow-up file has ${followUp.prs.length}`,
    );
  }
  file.prs.forEach((pr, i) => {
    const want = followUp.prs[i];
    if (!want) return;
    if (pr.number !== want.number) {
      problems.push(`prs[${i}].number is ${pr.number}, the follow-up file's is ${want.number}`);
      return;
    }
    const edges = pr.breaks.map((b) => b.edge);
    const wanted = want.breaks.map((b) => b.edge);
    if (JSON.stringify(edges) !== JSON.stringify(wanted)) {
      problems.push(`prs[${i}].breaks aren't the follow-up file's breaks of #${want.number}`);
      return;
    }
    pr.breaks.forEach((b, j) => {
      const found = want.breaks[j]?.fixed ?? null;
      if (found && !b.fix)
        problems.push(`prs[${i}].breaks[${j}] has no fix judgment, but the follow-up found a fix`);
      if (!found && b.fix)
        problems.push(`prs[${i}].breaks[${j}] judges a fix, but the follow-up found none`);
    });
  });
  return problems;
}

/** Totals over classification files: breaks, verdicts, fix judgments, and reviewed breaks. */
export function classifiedCounts(files: readonly ClassifiedFile[]): {
  breaks: number;
  verdicts: Record<Verdict, number>;
  fixes: Record<FixVerdict, number>;
  reviewed: number;
} {
  const verdicts: Record<Verdict, number> = { true: 0, false: 0, unclear: 0 };
  const fixes: Record<FixVerdict, number> = { real: 0, coincidental: 0, unclear: 0 };
  let breaks = 0;
  let reviewed = 0;
  for (const b of files.flatMap((f) => f.prs.flatMap((p) => p.breaks))) {
    breaks++;
    verdicts[b.verdict]++;
    if (b.fix) fixes[b.fix.verdict]++;
    if (b.reviewedBy !== null) reviewed++;
  }
  return { breaks, verdicts, fixes, reviewed };
}
