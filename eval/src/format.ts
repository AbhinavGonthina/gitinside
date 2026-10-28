/**
 * The eval's input formats (docs/EVALUATION.md §1): the pinned repo list `eval/repos.json` and
 * the ground-truth label files `eval/labels/<owner>__<name>.json`. Both are hand-written, so
 * every rule a scorer relies on (path spelling, route syntax, sort order, unique call sites) is
 * checked here rather than assumed later.
 */
import { compareStrings } from "@gitinside/schema";
import { z } from "zod";

/** Methods an outbound request can use. */
export const REQUEST_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

/** Methods a route can declare: the request methods plus `ALL` (any method). */
export const ROUTE_METHODS = [...REQUEST_METHODS, "ALL"] as const;

/** The five repo shapes EVALUATION.md §1 asks the eval set to cover. */
export const REPO_SHAPES = [
  "axios-baseurl",
  "env-api-urls",
  "next-api-routes",
  "next-plus-server-monorepo",
  "spa-plus-express",
] as const;

/** SPDX IDs accepted as permissive licenses for eval repos. */
export const PERMISSIVE_LICENSES = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Unlicense",
] as const;

/**
 * Whether `path` is spelled the one way labels allow: repo-relative, forward slashes, no
 * leading `./` or `/`, no empty, `.` or `..` segments. One spelling per file means call sites
 * can be compared as plain strings.
 */
export function isRepoPath(path: string): boolean {
  if (path === "" || path.includes("\\")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const repoPath = z.string().refine(isRepoPath, {
  message: "must be a repo-relative POSIX path (no leading ./ or /, no backslashes, no ..)",
});

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");

const positiveInt = z.number().int().min(1);

/**
 * Whether `path` is a route path in the analyzer's spelling (GRAPH_SCHEMA.md `route.path`):
 * the full path after mounts, starting with `/`, no trailing slash except the root, dynamic
 * segments as `:name` and catch-alls as `*name` (Next.js `[id]` ⇒ `:id`, `[...slug]` ⇒
 * `*slug`), no query string.
 */
export function isRoutePath(path: string): boolean {
  if (path === "/") return true;
  if (!path.startsWith("/") || path.endsWith("/")) return false;
  return path
    .slice(1)
    .split("/")
    .every((s) => /^[:*][A-Za-z0-9_$-]+$/.test(s) || /^[^\s:*?#[\]]+$/.test(s));
}

const route = z.string().refine(
  (text) => {
    const space = text.indexOf(" ");
    const method = text.slice(0, space);
    return (
      space > 0 &&
      (ROUTE_METHODS as readonly string[]).includes(method) &&
      isRoutePath(text.slice(space + 1))
    );
  },
  { message: 'must be "<METHOD> <path>", e.g. "POST /api/orders" or "GET /api/users/:id"' },
);

/** A place in the repo: 1-based line, plus a column when one line holds several calls. */
export const locationSchema = z
  .object({ file: repoPath, line: positiveInt, column: positiveInt.optional() })
  .strict();

/** The route a call reaches: where it is registered, and its method and full path. */
export const targetSchema = z.object({ file: repoPath, line: positiveInt, route }).strict();

/** One labeled outbound HTTP call site and the route it really reaches, or `null` for none. */
export const labeledEdgeSchema = z
  .object({
    callSite: locationSchema,
    /** The request's method; `null` when the code computes it at runtime. */
    method: z.enum(REQUEST_METHODS).nullable(),
    target: targetSchema.nullable(),
    notes: z.string().min(1).optional(),
  })
  .strict();

export type SourcePoint = z.infer<typeof locationSchema>;
export type LabeledEdge = z.infer<typeof labeledEdgeSchema>;

/** Order call sites by file, line, then column (a missing column sorts first). */
export function compareLocations(a: SourcePoint, b: SourcePoint): number {
  return compareStrings(a.file, b.file) || a.line - b.line || (a.column ?? 0) - (b.column ?? 0);
}

/** Whether `file` lies inside one of the label file's scope entries (`.` = the whole repo). */
export function inScope(scope: readonly string[], file: string): boolean {
  return scope.some((s) => s === "." || file === s || file.startsWith(`${s}/`));
}

/** Report each out-of-order or duplicate neighbor in `items` under `path`. */
function checkSorted<T>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
  path: (string | number)[],
  what: string,
  ctx: z.RefinementCtx,
): void {
  for (let i = 1; i < items.length; i++) {
    const order = compare(items[i - 1] as T, items[i] as T);
    if (order >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, i],
        message: order === 0 ? `duplicate ${what}` : `${what} out of order (must be sorted)`,
      });
    }
  }
}

/** A ground-truth label file, `eval/labels/<owner>__<name>.json`. */
export const labelFileSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/name"'),
    sha,
    /** Who drafted the labels: Claude reading the code (D10.3), or Abhinav. */
    labeler: z.enum(["claude-draft", "abhinav"]),
    /** GitHub login of the reviewer once the 20% review is done, else `null`. */
    reviewedBy: z.string().min(1).nullable(),
    /**
     * Repo-relative folders (or `.`) whose call sites are all labeled. Predictions outside the
     * scope are not scored; predictions inside it at unlabeled call sites are.
     */
    scope: z.array(z.union([z.literal("."), repoPath])).min(1),
    edges: z.array(labeledEdgeSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    checkSorted(file.scope, compareStrings, ["scope"], "scope entry", ctx);
    checkSorted(
      file.edges,
      (a, b) => compareLocations(a.callSite, b.callSite),
      ["edges"],
      "call site",
      ctx,
    );
    file.edges.forEach((edge, i) => {
      if (!inScope(file.scope, edge.callSite.file)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", i, "callSite", "file"],
          message: "call site is outside the label file's scope",
        });
      }
    });
  });

export type LabelFile = z.infer<typeof labelFileSchema>;

/** One pinned eval repo in `eval/repos.json`. */
export const evalRepoSchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    url: z.string(),
    sha,
    license: z.enum(PERMISSIVE_LICENSES),
    shape: z.enum(REPO_SHAPES),
    /** Why this repo is in the set: what it exercises. */
    why: z.string().min(1),
  })
  .strict()
  .refine((r) => r.url === `https://github.com/${r.owner}/${r.name}`, {
    message: "url must be https://github.com/<owner>/<name>",
    path: ["url"],
  });

export type EvalRepo = z.infer<typeof evalRepoSchema>;

/** `eval/repos.json`: the pinned repos, sorted by `owner/name`. */
export const reposFileSchema = z
  .object({ repos: z.array(evalRepoSchema) })
  .strict()
  .superRefine((file, ctx) => {
    const key = (r: EvalRepo): string => `${r.owner}/${r.name}`.toLowerCase();
    checkSorted(file.repos, (a, b) => compareStrings(key(a), key(b)), ["repos"], "repo", ctx);
  });

export type ReposFile = z.infer<typeof reposFileSchema>;

/** The label file name for a repo: `<owner>__<name>.json`. */
export function labelFileName(owner: string, name: string): string {
  return `${owner}__${name}.json`;
}

/** Thrown when an eval input file fails validation; the message lists every issue. */
export class EvalInputError extends Error {
  constructor(file: string, issues: readonly string[]) {
    super(`${file}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EvalInputError";
  }
}

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, file: string, text: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new EvalInputError(file, [`invalid JSON: ${(error as Error).message}`]);
  }
  const result = schema.safeParse(json);
  if (result.success) return result.data;
  throw new EvalInputError(
    file,
    result.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`),
  );
}

/** Parse and validate the text of a label file; `file` names it in errors. */
export function parseLabelFile(file: string, text: string): LabelFile {
  return parseWith(labelFileSchema, file, text);
}

/** Parse and validate the text of `eval/repos.json`; `file` names it in errors. */
export function parseReposFile(file: string, text: string): ReposFile {
  return parseWith(reposFileSchema, file, text);
}
