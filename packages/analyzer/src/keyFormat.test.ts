import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareStrings } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import type { FactCache } from "./cache.js";
import { FACTS_DIGESTS, KEY_FORMAT } from "./incremental.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
/** Every fixture with a golden graph, sorted. */
const NAMES = readdirSync(FIXTURES)
  .filter((name) => existsSync(join(FIXTURES, name, "expected.json")))
  .sort(compareStrings);

/** Every value a cold analysis of fixture `name` stores in a cache, serialized and sorted. */
async function stored(name: string): Promise<string[]> {
  const values: string[] = [];
  const cache: FactCache = {
    get: () => Promise.resolve(undefined),
    put: (_key, value) => {
      values.push(JSON.stringify(value));
      return Promise.resolve();
    },
  };
  await analyze(join(FIXTURES, name), { owner: "fixtures", name, cache });
  return values.sort(compareStrings);
}

/** The formats {@link FACTS_DIGESTS} records, in the order they're written. */
const FORMATS = Object.keys(FACTS_DIGESTS).map(Number);

/** Why `digest` isn't recorded for the current format, and what to do about it. */
function bumpMessage(digest: string): string {
  const earlier = FORMATS.find((format) => FACTS_DIGESTS[format] === digest);
  const next = KEY_FORMAT + 1;
  if (earlier !== undefined) {
    return (
      `The cache entries stored for the fixtures are those of KEY_FORMAT ${earlier}, not ` +
      `${KEY_FORMAT}'s. Bump KEY_FORMAT to ${next} in incremental.ts. No two formats may ` +
      `share a digest, so also add a fixture whose stored entries tell format ${next} from ` +
      `${earlier}, then add the digest this test prints under ${next}.`
    );
  }
  return (
    `The cache entries stored for the fixtures changed, so entries written by the old code ` +
    `would be reused with another meaning. Bump KEY_FORMAT (now ${KEY_FORMAT}) to ${next} in ` +
    `incremental.ts and add \`${next}: "${digest}"\` to FACTS_DIGESTS. Never change an ` +
    `existing entry.`
  );
}

describe("KEY_FORMAT (M6.11f, M6 review C3)", () => {
  it("is bumped whenever the entries stored for the fixtures change", async () => {
    const hash = createHash("sha256");
    for (const name of NAMES) {
      const values = await stored(name);
      expect(values.length, name).toBeGreaterThan(0);
      // Entries must not depend on where the checkout is, or the digest would differ by machine.
      const folder = join(FIXTURES, name);
      const spellings = [folder, folder.replaceAll("\\", "/")].map((s) =>
        JSON.stringify(s).slice(1, -1),
      );
      for (const value of values) {
        for (const spelling of spellings) expect(value.includes(spelling), name).toBe(false);
      }
      hash.update(JSON.stringify([name, values]));
    }
    const digest = hash.digest("hex");
    expect(digest, bumpMessage(digest)).toBe(FACTS_DIGESTS[KEY_FORMAT]);
  }, 600_000);
});

describe("FACTS_DIGESTS (M6 review R3)", () => {
  it("ends at the current KEY_FORMAT, so a digest added without a bump fails", () => {
    expect(FORMATS.length).toBeGreaterThan(0);
    expect(
      FORMATS.at(-1),
      `FACTS_DIGESTS's newest entry must be KEY_FORMAT's (${KEY_FORMAT}): bump KEY_FORMAT ` +
        `with the entry you added`,
    ).toBe(KEY_FORMAT);
  });

  it("records each format once, oldest first", () => {
    for (const format of FORMATS) expect(Number.isInteger(format), String(format)).toBe(true);
    expect(FORMATS).toEqual([...FORMATS].sort((a, b) => a - b));
  });

  it("gives no two formats one digest, so an old format's entries can't come back unbumped", () => {
    const digests = FORMATS.map((format) => FACTS_DIGESTS[format]);
    for (const digest of digests) expect(digest, "a SHA-256 in hex").toMatch(/^[0-9a-f]{64}$/);
    const shared = FORMATS.filter((format, i) => digests.indexOf(digests[i]) !== i);
    expect(shared, "formats whose digest an earlier format already has").toEqual([]);
  });
});
