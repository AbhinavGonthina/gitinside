/**
 * Where imports the analysis can't find in the repo usually point (M10.3d4, M10-design B4), so the
 * prototype's "Not in the repo · 84 imports" box can say what most of them are: documenso's
 * `remix` imports `./+types/root` and 74 more files React Router writes at build time, which no
 * checkout holds. A fixed table in the repo, matched on whole path segments: an import matches an
 * entry when the entry's segments appear in it in a row (`@documenso/prisma/generated/zod` is
 * Prisma's, `./+types/root` React Router's, `my+types/x` nothing), and the first entry that
 * matches wins. Only a note: the import itself stays exact in the box and the panel.
 *
 * Handled: the generated folders of the frameworks the analyzer reads, and the five prototype
 * repos' stored graphs (2026-11-14). Not handled: anything else says "Target not found in the
 * repo" (never a guess from a name like `dist/`), and a generator writing elsewhere (a custom
 * Prisma `output`) isn't known by its folder.
 *
 * Bump {@link GENERATED_PATHS_VERSION} whenever the table changes (its test pins the digest).
 */

/** The table's version; bumped with every change to {@link GENERATED_PATHS}. */
export const GENERATED_PATHS_VERSION = 1;

/** One known place imports point to that isn't in a checkout. */
export interface GeneratedPath {
  /** The segments to find in a row, joined by `/`: `+types`, `prisma/generated`. */
  segments: string;
  /** How the box names it: `./+types/*`. */
  shown: string;
  /** What it is, short enough for a card's subtitle: "React Router types". */
  note: string;
}

/** The entries, most specific first. */
export const GENERATED_PATHS: readonly GeneratedPath[] = [
  { segments: "+types", shown: "./+types/*", note: "React Router types" },
  { segments: ".react-router", shown: ".react-router/*", note: "React Router types" },
  {
    segments: "contentlayer/generated",
    shown: "contentlayer/generated",
    note: "Contentlayer content",
  },
  { segments: "prisma/generated", shown: "prisma/generated/*", note: "Prisma's generated code" },
  { segments: ".next", shown: ".next/*", note: "Next.js build output" },
  { segments: "__generated__", shown: "__generated__/*", note: "Generated code" },
  { segments: "node_modules", shown: "node_modules/*", note: "Installed packages" },
];

/** The entry an import's path matches, or undefined. */
export function generatedPathFor(expression: string): GeneratedPath | undefined {
  const path = `/${expression.replace(/[?#].*$/, "")}/`;
  return GENERATED_PATHS.find((g) => path.includes(`/${g.segments}/`));
}

/** The entry most of `expressions` match and how many do, if at least half of them match it. */
export function commonGeneratedPath(
  expressions: readonly string[],
): { path: GeneratedPath; count: number } | undefined {
  const counts = new Map<GeneratedPath, number>();
  for (const e of expressions) {
    const found = generatedPathFor(e);
    if (found) counts.set(found, (counts.get(found) ?? 0) + 1);
  }
  let best: { path: GeneratedPath; count: number } | undefined;
  // Table order breaks ties: a Map keeps first-match order, but the table's is the rule.
  for (const path of GENERATED_PATHS) {
    const count = counts.get(path) ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { path, count };
  }
  return best && best.count * 2 >= expressions.length ? best : undefined;
}
