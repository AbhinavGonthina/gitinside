import { compareStrings } from "@gitinside/schema";

/** The two themes every story is captured in, dark first (DESIGN_SYSTEM.md). */
export const VISUAL_THEMES = ["dark", "light"] as const;

/** One screenshot: a story in one theme. */
export interface VisualCase {
  storyId: string;
  theme: (typeof VISUAL_THEMES)[number];
  /** Test title, e.g. `Components/Edges / Kinds (light)`. */
  title: string;
  /** Baseline file name under `visual/baselines/`. */
  snapshot: string;
  /** Path of the story's iframe in the static Storybook, theme set by URL global. */
  url: string;
}

interface IndexEntry {
  id: string;
  type: string;
  title: string;
  name: string;
}

// Story ids become file names, so keep them to Storybook's own slug alphabet.
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

function isEntry(value: unknown): value is IndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e["id"] === "string" &&
    typeof e["type"] === "string" &&
    typeof e["title"] === "string" &&
    typeof e["name"] === "string"
  );
}

/**
 * Turns a static Storybook's `index.json` (format v5) into the visual
 * regression cases: every story (docs pages skipped) in each theme, sorted by
 * story id so the list and the baseline folder read the same everywhere.
 * Throws on an unknown format or an index with no stories, so a broken
 * Storybook build fails the visual run instead of passing it with zero tests.
 */
export function visualCases(index: unknown): VisualCase[] {
  if (typeof index !== "object" || index === null) {
    throw new Error("Storybook index.json is not an object");
  }
  const { v, entries } = index as Record<string, unknown>;
  if (v !== 5 || typeof entries !== "object" || entries === null) {
    throw new Error("Storybook index.json is not format v5 (expected { v: 5, entries })");
  }
  const stories: IndexEntry[] = [];
  for (const entry of Object.values(entries)) {
    if (!isEntry(entry))
      throw new Error("Storybook index.json has an entry without id/type/title/name");
    if (entry.type !== "story") continue;
    if (!SAFE_ID.test(entry.id)) throw new Error(`Unexpected story id ${JSON.stringify(entry.id)}`);
    stories.push(entry);
  }
  if (stories.length === 0) throw new Error("Storybook index.json has no stories");
  stories.sort((a, b) => compareStrings(a.id, b.id));
  return stories.flatMap((story) =>
    VISUAL_THEMES.map((theme) => ({
      storyId: story.id,
      theme,
      title: `${story.title} / ${story.name} (${theme})`,
      snapshot: `${story.id}--${theme}.png`,
      url: `/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`,
    })),
  );
}
