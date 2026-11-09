import {
  type ArchitectureGraph,
  type BrokenEdge,
  type GraphDiff,
  type GraphNode,
  type SourceLocation,
} from "@gitinside/schema";
import { BROKEN_WORDS, describeNode, renameLimitText, renderMermaidSummary } from "./mermaid.js";

/**
 * The PR bot's text (M8.6, ADR-0243): the comment it posts on a pull request and the Check
 * Run it completes on the head commit, both built from a stored diff and its two graphs.
 * Pure and deterministic: the same diff, graphs, and options give the same text, so a push
 * that changes nothing architectural edits the comment to identical text.
 *
 * Every piece of text from the repo (labels, details, file paths) is written as a Markdown
 * code span with control and format characters removed (SECURITY.md T10): inside one,
 * GitHub renders no HTML, links, images, `@` mentions, `#` references, or emphasis, and a
 * label can't end the hidden marker's comment. Links carry repo text only percent-encoded.
 */

/** First line of every comment the bot posts; M8.6e finds its own comment by it. */
export const PR_COMMENT_MARKER = "<!-- gitinside:pr-comment -->";

/** The Check Run's name on GitHub. */
export const CHECK_RUN_NAME = "GitInside";

/** GitHub's longest issue comment body, in characters. */
export const MAX_COMMENT_LENGTH = 65_536;

/**
 * Mermaid's default `maxTextSize`, in characters: past it Mermaid draws an error instead of
 * the diagram. GitHub documents no larger setting, so a summary longer than this is left out
 * of the comment (M8.10d), though the comment would fit {@link MAX_COMMENT_LENGTH}.
 */
export const MAX_MERMAID_LENGTH = 50_000;

/** GitHub's longest Check Run `output.summary`, in characters. */
export const MAX_CHECK_SUMMARY_LENGTH = 65_535;

/** Call sites listed per broken connection; the rest are counted. */
const MAX_SITES = 5;

/** Longest repo text written, in code points, before it's cut with "...". */
const MAX_TEXT = 160;

/** Options for {@link renderPrComment} and {@link renderCheckRun}. */
export interface PrTextOptions {
  /** The website's origin, for the interactive diff's link (`https://gitinside.abhinavgonthina.dev`). */
  siteOrigin: string;
}

/** What {@link renderCheckRun} gives the poster to complete the Check Run with. */
export interface CheckRunText {
  name: string;
  /** `neutral` when connections break (reviewers decide; the PR isn't blocked), else `success`. */
  conclusion: "neutral" | "success";
  title: string;
  summary: string;
}

/** Control, format (bidi overrides, zero-width), and line/paragraph separator characters. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Repo text as a Markdown code span: invisible characters removed, whitespace collapsed,
 * cut to `max` code points, fenced by one more backtick than its longest run (padded with
 * spaces when it starts or ends with one, which CommonMark strips again).
 */
export function markdownCode(text: string, max = MAX_TEXT): string {
  const chars = [...text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim()];
  const cut = chars.length > max ? [...chars.slice(0, max - 3), "..."] : chars;
  const body = cut.join("");
  if (body === "") return "` `";
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** A URL path segment from repo text: percent-encoded, parentheses too (they'd end a Markdown link). */
function segment(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

interface PrContext {
  owner: string;
  name: string;
  baseSha: string;
  headSha: string;
  diffUrl: string;
  /** One Markdown list item per broken connection, sites indented under it. */
  items: string[];
}

/** The repo, both SHAs, the link, and the listed broken connections, shared by both texts. */
function context(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: PrTextOptions,
): PrContext {
  // A plain scheme, host, and port: this package builds without DOM or Node types (no `URL`).
  const origin = options.siteOrigin.replace(/\/$/, "");
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
    throw new Error(`siteOrigin must be an origin, got ${options.siteOrigin}`);
  }
  const { owner, name } = diff.head.repo;
  const baseSha = diff.base.repo.sha;
  const headSha = diff.head.repo.sha;
  if (baseSha === undefined || headSha === undefined) {
    throw new Error("a PR's diff needs both commits' SHAs");
  }
  const diffUrl = `${origin}/${segment(owner)}/${segment(name)}/${headSha}?base=${baseSha}`;

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.map((n) => [n.id, n]));
  const inBase = (id: string): GraphNode | undefined => baseNodes.get(id);
  const inHead = (id: string): GraphNode | undefined => headNodes.get(id);
  const blob = (site: SourceLocation): string =>
    `https://github.com/${segment(owner)}/${segment(name)}/blob/${headSha}/${site.file
      .split("/")
      .map(segment)
      .join("/")}#L${site.line}`;

  const item = (b: BrokenEdge): string => {
    const from = inHead(b.from);
    const to = inBase(b.to);
    const fromText = from === undefined ? b.from : describeNode(from, inHead);
    const toText = to === undefined ? b.to : describeNode(to, inBase);
    const lines = [
      `- ${markdownCode(fromText)} → ${markdownCode(toText)}: **${BROKEN_WORDS[b.reason]}** — ${markdownCode(b.detail)}`,
    ];
    for (const site of b.sites.slice(0, MAX_SITES)) {
      lines.push(`  - [${markdownCode(`${site.file}:${site.line}`)}](${blob(site)})`);
    }
    const more = b.sites.length - MAX_SITES;
    if (more > 0) lines.push(`  - and ${plural(more, "more call site")}`);
    return lines.join("\n");
  };
  return { owner, name, baseSha, headSha, diffUrl, items: diff.broken.map(item) };
}

/**
 * Join `head`, as many of `items` as fit with `tail` in `max` characters (in order), a
 * count of the rest, and `tail`. Deterministic: fewer items only when the text is too long.
 */
function fit(head: string[], items: string[], tail: string[], max: number): string {
  const join = (listed: string[], rest: number): string =>
    [
      ...head,
      ...(listed.length > 0 ? [listed.join("\n")] : []),
      ...(rest > 0
        ? [`And ${plural(rest, "more broken connection")}, listed in the interactive diff.`]
        : []),
      ...tail,
    ].join("\n\n") + "\n";
  const full = join(items, 0);
  if (full.length <= max) return full;
  // Room for the count line at its longest, then items while they fit.
  const reserve = join([], items.length).length;
  let used = reserve;
  const listed: string[] = [];
  for (const item of items) {
    const cost = item.length + 1;
    if (used + cost > max) break;
    listed.push(item);
    used += cost;
  }
  return join(listed, items.length - listed.length);
}

/** Which commits were compared, by short SHA. */
function compared(ctx: PrContext): string {
  return `Compared base ${markdownCode(ctx.baseSha.slice(0, 7))} with head ${markdownCode(ctx.headSha.slice(0, 7))}.`;
}

/** The rename budget's note as a paragraph, or nothing. */
function limitNote(diff: GraphDiff): string[] {
  const text = renameLimitText(diff);
  return text === undefined ? [] : [`_${text}, so a moved file may show as removed and added._`];
}

/** The opening sentence: the broken count, or that nothing broke. */
function verdict(broken: number): string {
  return broken === 0
    ? "**No broken connections.** Every connection that worked at the base commit still does."
    : `**${plural(broken, "broken connection")}.** ${broken === 1 ? "It" : "Each"} worked at the base commit and no longer does at the head commit.`;
}

/**
 * The PR comment (Markdown, at most {@link MAX_COMMENT_LENGTH} characters): the hidden
 * marker, the broken count, each broken connection (source → target, the reason, its
 * detail, up to 5 head call sites linked at the head commit), the Mermaid summary
 * (`renderMermaidSummary`), a note when rename detection stopped at its budget, and the
 * link to the interactive diff (`/<owner>/<repo>/<head>?base=<base>`).
 *
 * When too long, it lists the first broken connections that fit and counts the rest; if
 * even the summary doesn't fit, or it's longer than {@link MAX_MERMAID_LENGTH} (Mermaid would
 * draw an error), it's left out with a note. Repo text is escaped as the
 * module comment says.
 */
export function renderPrComment(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: PrTextOptions,
): string {
  const ctx = context(diff, base, head, options);
  const top = [
    `${PR_COMMENT_MARKER}\n### GitInside architecture check`,
    verdict(diff.broken.length),
    compared(ctx),
    ...(ctx.items.length > 0 ? ["#### Broken connections"] : []),
  ];
  const after = [...limitNote(diff), `[Open the interactive diff](${ctx.diffUrl})`];
  const summary = renderMermaidSummary(diff, base, head);
  const withSummary = ["#### What changed", `\`\`\`mermaid\n${summary}\`\`\``, ...after];
  // Room for the summary with no item listed, the count line included; and no longer than
  // Mermaid draws.
  const tail =
    summary.length <= MAX_MERMAID_LENGTH &&
    fit(top, [], withSummary, Infinity).length + 200 <= MAX_COMMENT_LENGTH
      ? withSummary
      : ["_The change summary is too large for a comment; open the interactive diff._", ...after];
  return fit(top, ctx.items, tail, MAX_COMMENT_LENGTH);
}

/**
 * The Check Run for the PR's head commit: titled with the broken count, its summary the
 * same list as the comment (no diagram: Check Runs don't draw Mermaid) and the link, at
 * most {@link MAX_CHECK_SUMMARY_LENGTH} characters. Concludes `neutral` when connections
 * break, so a reviewer sees it without the PR being blocked, and `success` otherwise.
 */
export function renderCheckRun(
  diff: GraphDiff,
  base: ArchitectureGraph,
  head: ArchitectureGraph,
  options: PrTextOptions,
): CheckRunText {
  const ctx = context(diff, base, head, options);
  const broken = diff.broken.length;
  const top = [verdict(broken), compared(ctx)];
  const tail = [...limitNote(diff), `[Open the interactive diff](${ctx.diffUrl})`];
  return {
    name: CHECK_RUN_NAME,
    conclusion: broken === 0 ? "success" : "neutral",
    title: broken === 0 ? "No broken connections" : plural(broken, "broken connection"),
    summary: fit(top, ctx.items, tail, MAX_CHECK_SUMMARY_LENGTH),
  };
}
