import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareStrings, stringifyGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";

// Determinism (ADR-0003, TESTING.md): same input ⇒ byte-identical graph. Each fixture is
// analyzed twice in this process, then once more from a copy at a different absolute path
// (with a space and non-ASCII characters) so machine paths can't leak into the output.

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

let elsewhere: string;
beforeAll(async () => {
  elsewhere = await mkdtemp(join(tmpdir(), "gitinside determinism é-"));
});
afterAll(async () => {
  await rm(elsewhere, { recursive: true, force: true });
});

/** Every fixture folder, so a newly added fixture is covered without editing this test. */
const names = (await readdir(FIXTURES, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort(compareStrings);

/** Analyze `dir` under a fixed identity and return the canonical bytes. */
async function bytes(dir: string, name: string): Promise<string> {
  return stringifyGraph(await analyze(dir, { owner: "fixtures", name }));
}

describe("determinism", () => {
  it("covers at least the eight M1 fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  it.each(names)("%s is byte-identical across runs and checkout paths", async (name) => {
    const first = await bytes(join(FIXTURES, name), name);
    const second = await bytes(join(FIXTURES, name), name);
    expect(second).toBe(first);

    const copy = join(elsewhere, name);
    await cp(join(FIXTURES, name), copy, { recursive: true });
    expect(await bytes(copy, name)).toBe(first);
    expect(first).not.toContain(FIXTURES.replaceAll("\\", "/"));
  });
});
