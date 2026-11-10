import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareStrings } from "@gitinside/schema";
import { ANALYZER_VERSION, OUTPUT_DIGESTS } from "./version.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** Every fixture with a golden graph, sorted. `fixtures.test.ts` keeps each byte for byte. */
const NAMES = readdirSync(FIXTURES)
  .filter((name) => existsSync(join(FIXTURES, name, "expected.json")))
  .sort(compareStrings);

/** The SHA-256 of every golden graph, each without its `analyzerVersion`. */
function goldensDigest(): string {
  const hash = createHash("sha256");
  for (const name of NAMES) {
    // Parsed, so a checkout's line endings don't change the digest.
    const graph = JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")) as {
      analyzerVersion?: unknown;
    };
    expect(graph.analyzerVersion, name).toBe(ANALYZER_VERSION);
    const { analyzerVersion: _, ...rest } = graph;
    hash.update(JSON.stringify([name, rest]));
  }
  return hash.digest("hex");
}

/** The versions {@link OUTPUT_DIGESTS} records, in the order they're written. */
const VERSIONS = Object.keys(OUTPUT_DIGESTS);

/** Why `digest` isn't recorded for the current version, and what to do about it. */
function bumpMessage(digest: string): string {
  const earlier = VERSIONS.find((version) => OUTPUT_DIGESTS[version] === digest);
  if (earlier !== undefined) {
    return (
      `The fixtures' graphs are those of analyzer ${earlier}, not ${ANALYZER_VERSION}'s. Bump ` +
      `ANALYZER_VERSION past ${ANALYZER_VERSION} in version.ts, add a fixture whose graph tells ` +
      `the new version from ${earlier}, and add the digest this test prints under it.`
    );
  }
  return (
    `The fixtures' graphs changed, so production would keep serving graphs the old code made ` +
    `under the same version as current (M9.1b2a). Bump ANALYZER_VERSION (now ` +
    `${ANALYZER_VERSION}) in version.ts, regenerate the goldens, and add ` +
    `\`"<new version>": "${digest}"\` to OUTPUT_DIGESTS. Never change an existing entry.`
  );
}

describe("ANALYZER_VERSION (M9.1b2a)", () => {
  it("is bumped whenever a fixture's graph changes", () => {
    expect(NAMES.length).toBeGreaterThan(0);
    const digest = goldensDigest();
    expect(digest, bumpMessage(digest)).toBe(OUTPUT_DIGESTS[ANALYZER_VERSION]);
  });
});

describe("OUTPUT_DIGESTS (M9.1b2a)", () => {
  it("ends at the current ANALYZER_VERSION, so a digest added without a bump fails", () => {
    expect(VERSIONS.length).toBeGreaterThan(0);
    expect(
      VERSIONS.at(-1),
      `OUTPUT_DIGESTS's newest entry must be ANALYZER_VERSION's (${ANALYZER_VERSION}): bump ` +
        `ANALYZER_VERSION with the entry you added`,
    ).toBe(ANALYZER_VERSION);
  });

  it("records each version once, oldest first, as major.minor.patch", () => {
    for (const version of VERSIONS)
      expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    const parts = (version: string) => version.split(".").map(Number);
    for (let i = 1; i < VERSIONS.length; i++) {
      const [a, b] = [parts(VERSIONS[i - 1]!), parts(VERSIONS[i]!)];
      const order = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
      expect(order, `${VERSIONS[i - 1]} before ${VERSIONS[i]}`).toBeLessThan(0);
    }
  });

  it("gives no two versions one digest, so an old version's output can't come back unbumped", () => {
    const digests = VERSIONS.map((version) => OUTPUT_DIGESTS[version]);
    for (const digest of digests) expect(digest, "a SHA-256 in hex").toMatch(/^[0-9a-f]{64}$/);
    const shared = VERSIONS.filter((_, i) => digests.indexOf(digests[i]) !== i);
    expect(shared, "versions whose digest an earlier version already has").toEqual([]);
  });
});
