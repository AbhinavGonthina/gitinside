/**
 * The owner's label review sample (docs/EVALUATION.md §1, labeling step 3): a seeded random
 * 20% of call sites, drawn per repo so every label file gets checked. The seed is the date
 * the review issue is opened, so anyone can regenerate the exact list from the committed
 * labels and the issue's date.
 */
import { compareStrings } from "@gitinside/schema";
import {
  compareLocations,
  type EvalRepo,
  type LabeledEdge,
  type LabelFile,
  type SourcePoint,
} from "./format.js";

/** The share of each repo's call sites the owner reviews. */
export const REVIEW_FRACTION = 0.2;

/** One call site with every label at it (several when it reaches alternative routes). */
export interface SampledSite {
  callSite: SourcePoint;
  labels: LabeledEdge[];
}

/** The sampled call sites of one repo, sorted by call site, plus how many it has in total. */
export interface RepoSample {
  repo: EvalRepo;
  total: number;
  sites: SampledSite[];
}

/** 32-bit FNV-1a hash of `text`'s UTF-16 code units, used to turn a seed string into a number. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A mulberry32 generator: returns a function yielding numbers in [0, 1). Small, fast, and
 * the same on every platform, which is all a reproducible sample needs (not cryptographic).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher–Yates shuffle of a copy of `items`, driven by `seed`. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const next = mulberry32(hashSeed(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Group a label file's edges by call site, in label order (labels are sorted by call site). */
export function callSites(labels: LabelFile): SampledSite[] {
  const sites: SampledSite[] = [];
  for (const edge of labels.edges) {
    const last = sites.at(-1);
    if (last && compareLocations(last.callSite, edge.callSite) === 0) last.labels.push(edge);
    else sites.push({ callSite: edge.callSite, labels: [edge] });
  }
  return sites;
}

/**
 * Draw the review sample: for each repo (in the given order), shuffle its call sites with the
 * seed `<seed>/<owner>/<name>` and keep the first ⌈20%⌉, sorted back into call-site order.
 * Stratifying by repo guarantees each label file is reviewed; the per-repo seed keeps one
 * repo's sample independent of the others' sizes.
 */
export function drawReviewSample(
  entries: readonly { repo: EvalRepo; labels: LabelFile }[],
  seed: string,
): RepoSample[] {
  return entries.map(({ repo, labels }) => {
    const sites = callSites(labels);
    const count = Math.ceil(sites.length * REVIEW_FRACTION);
    const picked = seededShuffle(sites, `${seed}/${repo.owner}/${repo.name}`).slice(0, count);
    picked.sort((a, b) => compareLocations(a.callSite, b.callSite));
    return { repo, total: sites.length, sites: picked };
  });
}

/** A path segment escaped for a URL, parentheses included so Markdown links don't break. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A GitHub permalink to `file` at `line` in the pinned commit. */
export function permalink(repo: EvalRepo, file: string, line: number): string {
  const path = file.split("/").map(encodeSegment).join("/");
  return `${repo.url}/blob/${repo.sha}/${path}#L${line}`;
}

function siteText(site: SourcePoint): string {
  return `${site.file}:${site.line}${site.column === undefined ? "" : `:${site.column}`}`;
}

function labelText(repo: EvalRepo, label: LabeledEdge): string {
  const method = label.method ?? "(method computed at runtime)";
  const target = label.target
    ? `[\`${label.target.route}\`](${permalink(repo, label.target.file, label.target.line)})`
    : "**no route in this repo** (external host or unknowable URL)";
  return `\`${method}\` → ${target}${label.notes ? `. ${label.notes}` : ""}`;
}

/**
 * Render the sample as a Markdown checklist, one box per call site, with permalinks to the
 * call and to each labeled route at the pinned SHA.
 */
export function renderReviewSample(samples: readonly RepoSample[], seed: string): string {
  const picked = samples.reduce((n, s) => n + s.sites.length, 0);
  const total = samples.reduce((n, s) => n + s.total, 0);
  const lines = [
    `Seed \`${seed}\`: ${picked} of ${total} call sites (${REVIEW_FRACTION * 100}% of each repo, rounded up).`,
  ];
  const ordered = [...samples].sort((a, b) =>
    compareStrings(
      `${a.repo.owner}/${a.repo.name}`.toLowerCase(),
      `${b.repo.owner}/${b.repo.name}`.toLowerCase(),
    ),
  );
  for (const { repo, total: n, sites } of ordered) {
    lines.push(
      "",
      `### ${repo.owner}/${repo.name} (${sites.length} of ${n}, \`${repo.sha.slice(0, 7)}\`)`,
      "",
    );
    for (const { callSite, labels } of sites) {
      const link = `[\`${siteText(callSite)}\`](${permalink(repo, callSite.file, callSite.line)})`;
      if (labels.length === 1) {
        lines.push(`- [ ] ${link}: ${labelText(repo, labels[0] as LabeledEdge)}`);
      } else {
        lines.push(`- [ ] ${link}: reaches ${labels.length} routes`);
        for (const label of labels) lines.push(`  - ${labelText(repo, label)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
