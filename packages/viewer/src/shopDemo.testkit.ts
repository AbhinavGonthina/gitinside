import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGraph, type ArchitectureGraph } from "@gitinside/schema";

// Test-only: fixtures/shop-demo read from disk, as the stories read it
// through Vite. Paths are from the package folder, where Vitest runs (a
// file URL from import.meta.url isn't available under jsdom).

const FIXTURE = join(process.cwd(), "../../fixtures/shop-demo");

/** The analyzer's golden output for fixtures/shop-demo, validated against the schema. */
export function shopDemo(): ArchitectureGraph {
  return parseGraph(JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")));
}

/** Fixture files by repo-relative path, for code previews. */
export function shopDemoSources(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((p) => [p, readFileSync(join(FIXTURE, p), "utf8")]));
}
