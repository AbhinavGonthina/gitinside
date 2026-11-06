import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareStrings } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import type { FactCache } from "./cache.js";
import { FACTS_DIGEST, KEY_FORMAT } from "./incremental.js";

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
    expect(
      digest,
      `The cache entries stored for the fixtures changed, so entries written by the old code ` +
        `would be reused with another meaning. Bump KEY_FORMAT (now ${KEY_FORMAT}) in ` +
        `incremental.ts and set FACTS_DIGEST to "${digest}".`,
    ).toBe(FACTS_DIGEST);
  }, 600_000);
});
