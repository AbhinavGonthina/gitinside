import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffGraphs } from "@gitinside/diff";
import { parseGraph, type ArchitectureGraph, type GraphDiff } from "@gitinside/schema";

// Test-only: a fixtures/diff-* pair read from disk, as `shopDemo.testkit.ts`
// reads the demo, with the diff computed from both sides' files.

const FIXTURES = join(process.cwd(), "../../fixtures");

/** A fixture's golden graph, validated against the schema. */
export function fixtureGraph(name: string): ArchitectureGraph {
  return parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));
}

/** A file's text from a fixture folder, for rename detection; absent files are `undefined`. */
const fromDisk =
  (name: string) =>
  (path: string): string | undefined => {
    try {
      return readFileSync(join(FIXTURES, name, path), "utf8");
    } catch {
      return undefined;
    }
  };

/** `fixtures/<name>-base` and `-head`, and their diff (with file contents, so renames pair). */
export function diffPair(name: string): {
  base: ArchitectureGraph;
  head: ArchitectureGraph;
  diff: GraphDiff;
} {
  const base = fixtureGraph(`${name}-base`);
  const head = fixtureGraph(`${name}-head`);
  const contents = { base: fromDisk(`${name}-base`), head: fromDisk(`${name}-head`) };
  return { base, head, diff: diffGraphs(base, head, { contents }) };
}
