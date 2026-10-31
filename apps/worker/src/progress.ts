/**
 * Where a running job is, in data and in words (UX.md "Analyze"; ADR-0064).
 *
 * A job moves through four {@link JobStage}s. Inside `analyze`, the child streams the
 * analyzer's own stages (its {@link AnalyzerStep}s) with counts where the analyzer knows
 * them, and the worker stores the latest as BullMQ progress, together with what the analyzer
 * has found so far ({@link FoundFacts}: services, routes, data stores, outside services; #8).
 * The progress page (M5.7) turns the stored facts into text with {@link describeProgress} and
 * {@link describeFound}.
 *
 * This module has no dependencies, so the child protocol and the website can import it
 * (`@gitinside/worker/progress`) without loading the analyzer or BullMQ.
 */

/** Where a running job is; `GET /jobs/:id` shows it. */
export type JobStage = "download" | "extract" | "analyze" | "upload";

/** Coarse progress (0–100) at the start of each stage. */
export const STAGE_PROGRESS: Readonly<Record<JobStage, number>> = {
  download: 0,
  extract: 10,
  analyze: 30,
  upload: 90,
};

/**
 * The analyzer's pipeline stages in run order: a copy of the analyzer's `ANALYSIS_STAGES`
 * (progress.test.ts keeps them equal), so checking the child's output needs no analyzer.
 */
export const ANALYZER_STEPS = [
  "inventory",
  "workspace",
  "programs",
  "imports",
  "express",
  "next",
  "prisma",
  "infra",
  "files",
  "symbols",
  "calls",
  "http",
  "sdk",
  "queues",
  "assemble",
] as const;

/** One analyzer stage, as streamed from the child. */
export type AnalyzerStep = (typeof ANALYZER_STEPS)[number];

/** One progress event from the analyzer: a step starting, or its count becoming known. */
export interface StepProgress {
  step: AnalyzerStep;
  /** Source files for `programs`, requests for `http`. */
  count?: number;
}

/** Names the analysis found, as stored and sent: the first few, and how many there are. */
export interface FoundNames {
  /** Every name found (at least `names.length`). */
  count: number;
  /** The first {@link FOUND_NAMES_MAX}, sorted as the analyzer sorts them, each capped. */
  names: string[];
}

/**
 * What the analysis has found so far (#8): the analyzer's findings with each list capped, so
 * a repo can't make the stored progress big. A key appears once its stage has run.
 */
export interface FoundFacts {
  services?: FoundNames;
  routes?: number;
  pages?: number;
  /** Datastores and queues. */
  stores?: FoundNames;
  /** External services (literal hosts, SDKs). */
  externals?: FoundNames;
}

/** Names kept per list; the rest are counted. */
export const FOUND_NAMES_MAX = 8;
/** Characters kept per name; longer ones end in `…`. */
export const FOUND_NAME_LENGTH = 64;

// Control and format characters (bidi overrides included) never reach a page.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/gu;
const HAS_HIDDEN_CHAR = /[\p{Cc}\p{Cf}]/u;
const LIST_KEYS = ["services", "stores", "externals"] as const;
const COUNT_KEYS = ["routes", "pages"] as const;

/** A name as stored: hidden characters replaced, at most {@link FOUND_NAME_LENGTH} characters. */
function foundName(name: string): string {
  const chars = Array.from(name.replace(HIDDEN_CHARS, "�"));
  if (chars.length <= FOUND_NAME_LENGTH) return chars.join("");
  return `${chars.slice(0, FOUND_NAME_LENGTH - 1).join("")}…`;
}

/** The analyzer's findings (`AnalysisFindings`), capped for storage. */
export function foundFacts(findings: {
  services?: readonly string[];
  routes?: number;
  pages?: number;
  stores?: readonly string[];
  externals?: readonly string[];
}): FoundFacts {
  const facts: FoundFacts = {};
  for (const key of LIST_KEYS) {
    const names = findings[key];
    if (names !== undefined) {
      facts[key] = { count: names.length, names: names.slice(0, FOUND_NAMES_MAX).map(foundName) };
    }
  }
  for (const key of COUNT_KEYS) {
    const count = findings[key];
    if (count !== undefined) facts[key] = count;
  }
  return facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isFoundName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    Array.from(value).length <= FOUND_NAME_LENGTH &&
    !HAS_HIDDEN_CHAR.test(value)
  );
}

function parseFoundNames(value: unknown): FoundNames | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
  const { count, names } = value;
  if (!isCount(count) || !Array.isArray(names) || names.length > FOUND_NAMES_MAX) return undefined;
  if (names.length > count || !names.every(isFoundName)) return undefined;
  return { count, names: [...names] };
}

/**
 * `value` as {@link FoundFacts} if it is exactly that shape (known keys only, lists within
 * the caps, names without hidden characters), else `undefined`. Every hop checks it: the
 * child's line, the stored progress, and the website's copy of the status.
 */
export function parseFoundFacts(value: unknown): FoundFacts | undefined {
  if (!isRecord(value)) return undefined;
  const facts: FoundFacts = {};
  for (const [key, field] of Object.entries(value)) {
    if ((LIST_KEYS as readonly string[]).includes(key)) {
      const names = parseFoundNames(field);
      if (names === undefined) return undefined;
      facts[key as (typeof LIST_KEYS)[number]] = names;
    } else if ((COUNT_KEYS as readonly string[]).includes(key) && isCount(field)) {
      facts[key as (typeof COUNT_KEYS)[number]] = field;
    } else {
      return undefined;
    }
  }
  return facts;
}

/** One line of what was found, for the progress page: "Services" / "@shop/api, @shop/web". */
export interface FoundLine {
  key: "services" | "routes" | "stores" | "externals";
  label: string;
  text: string;
}

/** `a, b, and 3 more`: the names, then how many weren't kept. */
function nameList({ count, names }: FoundNames): string {
  const rest = count - names.length;
  return rest > 0 ? `${names.join(", ")}, and ${formatCount(rest)} more` : names.join(", ");
}

/**
 * The words for what was found, in a fixed order, leaving out anything not found (yet):
 * services, routes and pages ("2 routes, 3 pages"), data stores, external services.
 */
export function describeFound(found: FoundFacts): FoundLine[] {
  const lines: FoundLine[] = [];
  const { services, routes = 0, pages = 0, stores, externals } = found;
  if (services !== undefined && services.count > 0) {
    lines.push({
      key: "services",
      label: services.count === 1 ? "Service" : `${formatCount(services.count)} services`,
      text: nameList(services),
    });
  }
  const entries = [
    ...(routes > 0 ? [plural(routes, "route")] : []),
    ...(pages > 0 ? [plural(pages, "page")] : []),
  ];
  if (entries.length > 0)
    lines.push({ key: "routes", label: "Entry points", text: entries.join(", ") });
  if (stores !== undefined && stores.count > 0) {
    lines.push({ key: "stores", label: "Data", text: nameList(stores) });
  }
  if (externals !== undefined && externals.count > 0) {
    lines.push({ key: "externals", label: "Outside services", text: nameList(externals) });
  }
  return lines;
}

/** Whether `value` names an analyzer step. */
export function isAnalyzerStep(value: unknown): value is AnalyzerStep {
  return typeof value === "string" && (ANALYZER_STEPS as readonly string[]).includes(value);
}

/**
 * Overall progress at the start of `step`: the analyzer's steps share the span between the
 * `analyze` and `upload` stages evenly, so `inventory` is 30 and `assemble` 86.
 */
export function stepProgress(step: AnalyzerStep): number {
  const span = STAGE_PROGRESS.upload - STAGE_PROGRESS.analyze;
  return (
    STAGE_PROGRESS.analyze +
    Math.floor((span * ANALYZER_STEPS.indexOf(step)) / ANALYZER_STEPS.length)
  );
}

/** `1204` ⇒ `1,204`, the same on every machine (no locale data involved). */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What the page says once a job has run past its estimate. */
export const TAKING_LONGER = "Taking longer than usual";

/**
 * The words for the time a job has left (`leftMs`, estimate.ts; #8): coarse on purpose, so
 * they change every few seconds at most and never pretend to be exact. 0 (past the estimate)
 * is {@link TAKING_LONGER}; under 10 s "A few seconds left"; under a minute rounded up to
 * 10 s ("About 40 s left"); then whole minutes ("About 3 min left").
 */
export function describeTimeLeft(leftMs: number): string {
  if (leftMs <= 0) return TAKING_LONGER;
  if (leftMs < 10_000) return "A few seconds left";
  const seconds = Math.ceil(leftMs / 10_000) * 10;
  if (seconds < 60) return `About ${seconds} s left`;
  return `About ${formatCount(Math.max(1, Math.round(leftMs / 60_000)))} min left`;
}

const STAGE_TEXT: Readonly<Record<JobStage, string>> = {
  download: "Downloading",
  extract: "Unpacking",
  analyze: "Analyzing",
  upload: "Saving the diagram",
};

const STEP_TEXT: Readonly<Record<AnalyzerStep, string>> = {
  inventory: "Listing files",
  workspace: "Finding packages",
  programs: "Parsing files",
  imports: "Resolving imports",
  express: "Finding Express routes",
  next: "Finding Next.js routes",
  prisma: "Reading Prisma models",
  infra: "Reading docker-compose and .env files",
  files: "Building the file tree",
  symbols: "Finding functions and classes",
  calls: "Linking function calls",
  http: "Finding HTTP calls",
  sdk: "Finding SDK calls",
  queues: "Finding queues",
  assemble: "Assembling the diagram",
};

const plural = (count: number, word: string): string =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * The words for a running job: "Downloading", "Parsing 1,204 files", "Linking 87 calls to
 * routes". A step only counts inside `analyze`; elsewhere the stage's own words win.
 */
export function describeProgress(stage: JobStage, step?: AnalyzerStep, count?: number): string {
  if (stage !== "analyze" || step === undefined) return STAGE_TEXT[stage];
  if (count !== undefined && step === "programs") return `Parsing ${plural(count, "file")}`;
  if (count !== undefined && step === "http") return `Linking ${plural(count, "call")} to routes`;
  return STEP_TEXT[step];
}
