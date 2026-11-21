import {
  compareStrings,
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

/** Longest rule message or config problem written, in code points. */
const MAX_MESSAGE = 300;

/**
 * One rule violation (or uncertain edge) as the PR texts draw it: the fields they read of
 * `@gitinside/rules`' `RuleViolation`, written out here so this package needs no dependency on it.
 */
export interface PrRuleViolation {
  /** The rule's ID. */
  rule: string;
  level: "error" | "warning";
  /** One sentence saying what's wrong (it holds repo names, so it's escaped). */
  message: string;
  /** The edges it rests on; only their head call sites are drawn. */
  edges: { sites: SourceLocation[] }[];
}

/** One problem in a `.gitinside.yml`, as `@gitinside/rules`' `ConfigIssue`. */
export interface PrConfigIssue {
  /** Where in the file, as a dotted path, or `""` for the whole file. */
  path: string;
  line?: number;
  message: string;
}

/**
 * The architecture rules' outcome on a PR (M15.1): `result` is `@gitinside/rules`'
 * `evaluateRulesOnDiff` answer (or `parseRulesConfig`'s issues), so its violations are only those
 * the PR introduces.
 */
export interface PrRules {
  result:
    | { ok: true; report: { violations: PrRuleViolation[]; uncertain: PrRuleViolation[] } }
    | { ok: false; issues: PrConfigIssue[] };
  /** Whether the PR adds or edits `.gitinside.yml`, so the head's rules were the ones used. */
  configChanged: boolean;
}

/** Options for {@link renderPrComment} and {@link renderCheckRun}. */
export interface PrTextOptions {
  /** The website's origin, for the interactive diff's link (`https://gitinside.abhinavgonthina.dev`). */
  siteOrigin: string;
  /** The repo's architecture rules on this PR; leave it out when the repo has no `.gitinside.yml`. */
  rules?: PrRules;
  /**
   * The website's image of what the PR changes (M15.2c), drawn above the comment's text; leave it
   * out when the website can't draw it. Only {@link renderPrComment} reads it.
   */
  diagram?: PrDiagram;
}

/** Where the comment's image is (the website's `/api/pr-diagram/<owner>/<repo>/<base>/<head>.svg`). */
export interface PrDiagram {
  /** The repo as the website stores it now (its URL redirects any other spelling). */
  owner: string;
  name: string;
  /** A private repo's signed token (`<expiry>.<64 hex>`, the worker's `signPrDiagram`). */
  token?: string;
}

/** What {@link renderCheckRun} gives the poster to complete the Check Run with. */
export interface CheckRunText {
  name: string;
  /**
   * `failure` when the PR breaks an `error`-level rule; `neutral` when connections break or a
   * `warning` rule does, or the rules couldn't be checked (reviewers decide; the PR isn't blocked);
   * else `success`.
   */
  conclusion: "failure" | "neutral" | "success";
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
  /** The website's origin, without a trailing slash. */
  origin: string;
  owner: string;
  name: string;
  baseSha: string;
  headSha: string;
  diffUrl: string;
  /** One Markdown list item per broken connection, sites indented under it. */
  items: string[];
  /** The rules section, when the repo has rules. */
  rules: Listing | undefined;
}

/** Call sites as list lines indented under an item: up to {@link MAX_SITES} linked, the rest counted. */
function siteLines(sites: SourceLocation[], blob: (site: SourceLocation) => string): string[] {
  const lines = sites
    .slice(0, MAX_SITES)
    .map((site) => `  - [${markdownCode(`${site.file}:${site.line}`)}](${blob(site)})`);
  const more = sites.length - MAX_SITES;
  if (more > 0) lines.push(`  - and ${plural(more, "more call site")}`);
  return lines;
}

/** A violation's sites over all its edges, each once, sorted by file, line, and column. */
function violationSites(violation: PrRuleViolation): SourceLocation[] {
  const unique = new Map<string, SourceLocation>();
  for (const site of violation.edges.flatMap((edge) => edge.sites)) {
    unique.set(`${site.file}:${site.line}:${site.column}`, site);
  }
  return [...unique.values()].sort(
    (a, b) => compareStrings(a.file, b.file) || a.line - b.line || a.column - b.column,
  );
}

/** The configuration file, in our own words (never repo text). */
const CONFIG = "`.gitinside.yml`";

/**
 * The "Architecture rules" section (M15.1a): the heading and a verdict, then one item per new
 * violation (level, rule ID, message, its head call sites) or per problem in the file, then notes
 * for new unresolved connections and a config the PR changed.
 */
function rulesListing(rules: PrRules, blob: (site: SourceLocation) => string): Listing {
  const heading = "#### Architecture rules";
  const changed = rules.configChanged
    ? [`_This PR changes ${CONFIG}, so the head commit's rules were used._`]
    : [];
  if (!rules.result.ok) {
    const { issues } = rules.result;
    const issueItem = (issue: PrConfigIssue): string => {
      const place = issue.path === "" ? "The file" : markdownCode(issue.path);
      const line = issue.line === undefined ? "" : `, line ${issue.line}`;
      return `- ${place}${line}: ${markdownCode(issue.message, MAX_MESSAGE)}`;
    };
    return {
      lead: [
        heading,
        `**${CONFIG} couldn't be checked:** ${plural(issues.length, "problem")}. Fix ${issues.length === 1 ? "it" : "them"} to have its rules checked.`,
      ],
      items: issues.map(issueItem),
      more: (rest) => `And ${plural(rest, "more problem")}, not listed here.`,
      trail: changed,
    };
  }
  const { violations, uncertain } = rules.result.report;
  const errors = violations.filter((v) => v.level === "error").length;
  const verdict =
    violations.length === 0
      ? `**No new rule violations.** The head commit breaks no rule in ${CONFIG} that the base commit didn't.`
      : `**${plural(violations.length, "new rule violation")}:** ${plural(errors, "error")}, ${plural(violations.length - errors, "warning")}. ${errors > 0 ? "An error-level rule broken fails this check." : "Warnings don't fail this check."}`;
  const item = (v: PrRuleViolation): string =>
    [
      `- **${v.level === "error" ? "Error" : "Warning"}**, rule ${markdownCode(v.rule)}: ${markdownCode(v.message, MAX_MESSAGE)}`,
      ...siteLines(violationSites(v), blob),
    ].join("\n");
  const one = uncertain.length === 1;
  return {
    lead: [heading, verdict],
    items: violations.map(item),
    more: (rest) => `And ${plural(rest, "more rule violation")}, not listed here.`,
    trail: [
      ...(uncertain.length === 0
        ? []
        : [
            `_${plural(uncertain.length, "new unresolved connection")} may also break a rule. GitInside couldn't tell where ${one ? "it goes" : "they go"}, so ${one ? "it isn't" : "they aren't"} judged._`,
          ]),
      ...changed,
    ],
  };
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
    return [
      `- ${markdownCode(fromText)} → ${markdownCode(toText)}: **${BROKEN_WORDS[b.reason]}** — ${markdownCode(b.detail)}`,
      ...siteLines(b.sites, blob),
    ].join("\n");
  };
  return {
    origin,
    owner,
    name,
    baseSha,
    headSha,
    diffUrl,
    items: diff.broken.map(item),
    rules: options.rules === undefined ? undefined : rulesListing(options.rules, blob),
  };
}

/** A list in a text: paragraphs before it, its items, a count of those left out, paragraphs after. */
interface Listing {
  lead: string[];
  items: string[];
  /** The paragraph counting `rest` items left out. */
  more: (rest: number) => string;
  trail: string[];
}

/** The broken connections as a {@link Listing}, under `lead` when any broke. */
function brokenListing(ctx: PrContext, lead: string[]): Listing {
  return {
    lead: ctx.items.length > 0 ? lead : [],
    items: ctx.items,
    more: (rest) =>
      `And ${plural(rest, "more broken connection")}, listed in the interactive diff.`,
    trail: [],
  };
}

/** The listings in text order (broken connections, then rules) and the order they're filled in. */
function listings(ctx: PrContext, brokenLead: string[]): { lists: Listing[]; fillOrder: number[] } {
  const broken = brokenListing(ctx, brokenLead);
  // Rule violations decide the conclusion, so they keep their room first.
  return ctx.rules === undefined
    ? { lists: [broken], fillOrder: [0] }
    : { lists: [broken, ctx.rules], fillOrder: [1, 0] };
}

/**
 * Join `head`, each of `lists` (its lead, as many items as fit, a count of the rest, its trail),
 * and `tail` in `max` characters, filling the lists' items in `fillOrder`. Deterministic: fewer
 * items only when the text is too long.
 */
function fit(
  head: string[],
  lists: Listing[],
  tail: string[],
  max: number,
  fillOrder: number[] = lists.map((_, i) => i),
): string {
  const join = (counts: readonly number[]): string =>
    [
      ...head,
      ...lists.flatMap((list, i) => {
        const listed = list.items.slice(0, counts[i] ?? 0);
        const rest = list.items.length - listed.length;
        return [
          ...list.lead,
          ...(listed.length > 0 ? [listed.join("\n")] : []),
          ...(rest > 0 ? [list.more(rest)] : []),
          ...list.trail,
        ];
      }),
      ...tail,
    ].join("\n\n") + "\n";
  const full = join(lists.map((list) => list.items.length));
  if (full.length <= max) return full;
  // Room for every count line at its longest, then items while they fit. A count line only
  // gets shorter as items are listed, so the text stays within `max`.
  const counts = lists.map(() => 0);
  let used = join(counts).length;
  for (const i of fillOrder) {
    for (const item of lists[i]?.items ?? []) {
      // The first item adds a paragraph break, the others a line break.
      const cost = item.length + (counts[i] === 0 ? 2 : 1);
      if (used + cost > max) break;
      counts[i] = (counts[i] ?? 0) + 1;
      used += cost;
    }
  }
  return join(counts);
}

/** A PR image token's shape, as the website's route accepts it. */
const DIAGRAM_TOKEN = /^[1-9][0-9]{0,11}\.[0-9a-f]{64}$/;

/** What the image's alt text says (and a screen reader). */
export const PR_DIAGRAM_ALT =
  "What this pull request changes in the architecture, drawn by GitInside";

/**
 * The image above the comment's text (M15.2c): HTML, since Markdown has no `<picture>`, as the
 * README image's snippet is. Each GitHub theme asks for its own `?theme=` (GitHub's proxy shows it
 * as an `<img>`, where the SVG's own media query would follow the system, not GitHub's theme), and
 * the image links to the interactive diff. Every part is our own text, percent-encoded repo names,
 * hex SHAs, or a token of the checked shape, and `&` is escaped for the attribute.
 */
function diagramLines(ctx: PrContext, diagram: PrDiagram): string {
  const { token } = diagram;
  if (token !== undefined && !DIAGRAM_TOKEN.test(token)) {
    throw new Error("the diagram's token must be <expiry>.<64 hex>");
  }
  const path = `${ctx.origin}/api/pr-diagram/${segment(diagram.owner)}/${segment(diagram.name)}/${ctx.baseSha}/${ctx.headSha}.svg`;
  const url = (theme: "dark" | "light") =>
    `${path}?theme=${theme}${token === undefined ? "" : `&amp;token=${token}`}`;
  return [
    `<a href="${ctx.diffUrl}">`,
    "  <picture>",
    `    <source media="(prefers-color-scheme: dark)" srcset="${url("dark")}">`,
    `    <img alt="${PR_DIAGRAM_ALT}" src="${url("light")}">`,
    "  </picture>",
    "</a>",
  ].join("\n");
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
 * link to the interactive diff (`/<owner>/<repo>/<head>?base=<base>`). With `options.rules`,
 * an "Architecture rules" section follows the broken list: each violation the PR introduces
 * (level, rule ID, message, up to 5 head call sites), or each problem in a config that couldn't
 * be checked. With `options.diagram`, the website's image of the change (M15.2c) comes first,
 * under the heading, linked to the interactive diff; the Mermaid summary stays, since it shows
 * even when the image can't (a private repo's token expires after 30 days).
 *
 * When too long, it lists the first rule violations, then broken connections, that fit and
 * counts the rest; if
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
    ...(options.diagram === undefined ? [] : [diagramLines(ctx, options.diagram)]),
    verdict(diff.broken.length),
    compared(ctx),
  ];
  const { lists, fillOrder } = listings(ctx, ["#### Broken connections"]);
  const empty = lists.map((list) => ({ ...list, items: [] }));
  const after = [...limitNote(diff), `[Open the interactive diff](${ctx.diffUrl})`];
  const summary = renderMermaidSummary(diff, base, head);
  const withSummary = ["#### What changed", `\`\`\`mermaid\n${summary}\`\`\``, ...after];
  // Room for the summary with no item listed, the count lines included; and no longer than
  // Mermaid draws.
  const tail =
    summary.length <= MAX_MERMAID_LENGTH &&
    fit(top, empty, withSummary, Infinity).length + 200 <= MAX_COMMENT_LENGTH
      ? withSummary
      : ["_The change summary is too large for a comment; open the interactive diff._", ...after];
  return fit(top, lists, tail, MAX_COMMENT_LENGTH, fillOrder);
}

/** The Check Run's conclusion (see {@link CheckRunText.conclusion}). */
function conclusion(broken: number, rules: PrRules | undefined): CheckRunText["conclusion"] {
  if (rules === undefined) return broken === 0 ? "success" : "neutral";
  const { result } = rules;
  if (result.ok && result.report.violations.some((v) => v.level === "error")) return "failure";
  const ruled = !result.ok || result.report.violations.length > 0;
  return broken === 0 && !ruled ? "success" : "neutral";
}

/** The Check Run's title: the rule violations (when the repo has rules) and the broken count. */
function checkTitle(broken: number, rules: PrRules | undefined): string {
  const connections = broken === 0 ? "no broken connections" : plural(broken, "broken connection");
  let text: string;
  if (rules === undefined) text = connections;
  else if (!rules.result.ok) text = `${connections}, rules not checked`;
  else {
    const n = rules.result.report.violations.length;
    if (n > 0) text = `${plural(n, "rule violation")}, ${connections}`;
    else if (broken === 0) text = "no broken connections or rule violations";
    else text = `${connections}, no rule violations`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The Check Run for the PR's head commit: titled with the rule violations and the broken
 * count, its summary the same lists as the comment (no diagram: Check Runs don't draw Mermaid)
 * and the link, at most {@link MAX_CHECK_SUMMARY_LENGTH} characters. Concludes `failure` only
 * when the PR breaks an `error`-level rule, `neutral` when connections break, a `warning` rule
 * breaks, or the rules couldn't be checked, so a reviewer sees it without the PR being blocked,
 * and `success` otherwise.
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
  const { lists, fillOrder } = listings(ctx, []);
  return {
    name: CHECK_RUN_NAME,
    conclusion: conclusion(broken, options.rules),
    title: checkTitle(broken, options.rules),
    summary: fit(top, lists, tail, MAX_CHECK_SUMMARY_LENGTH, fillOrder),
  };
}
