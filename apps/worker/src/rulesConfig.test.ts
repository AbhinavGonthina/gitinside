import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_STORED_RULES_CONFIG_BYTES } from "@gitinside/db";
import { diffGraphs } from "@gitinside/diff";
import { MAX_CONFIG_BYTES, parseRulesConfig } from "@gitinside/rules";
import { parseGraph } from "@gitinside/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RULES_CONFIG_FILE,
  checkRules,
  readRulesConfig,
  rulesConfigOf,
  storedConfigText,
} from "./rulesConfig.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

const graphOf = (name: string) =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")) as unknown);

/** diff-rename's two sides: `src/routes/orders.ts` moved to `src/orders/routes.ts`. */
const base = graphOf("diff-rename-base");
const head = graphOf("diff-rename-head");
/** A side's file text, which finds the moved file that was also edited (ADR-0086). */
const textOf = (name: string) => (path: string) => {
  try {
    return readFileSync(join(FIXTURES, name, path), "utf8");
  } catch {
    return undefined;
  }
};
const made = {
  diff: diffGraphs(base, head, {
    contents: { base: textOf("diff-rename-base"), head: textOf("diff-rename-head") },
  }),
  base,
  head,
};

/** A config forbidding `from`'s files from importing or calling `src/util/`. */
const forbid = (...from: string[]): string =>
  [
    "version: 1",
    "layers:",
    `  app: { paths: [${from.map((p) => JSON.stringify(p)).join(", ")}] }`,
    '  util: { paths: ["src/util/**"] }',
    "rules:",
    "  - { id: no-util, type: forbid-dependency, from: app, to: util, edges: [imports, calls] }",
    "",
  ].join("\n");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitinside-rules-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("storedConfigText", () => {
  it("cuts at the database's cap, which is the rules' limit plus one byte", () => {
    expect(MAX_STORED_RULES_CONFIG_BYTES).toBe(MAX_CONFIG_BYTES + 1);
  });

  it("keeps a file within the limit as it is", () => {
    const text = `version: 1\nrules: []\n# ${"é".repeat(100)}\n`;
    expect(storedConfigText(Buffer.from(text))).toBe(text);
    const atLimit = `# ${"x".repeat(MAX_CONFIG_BYTES - 3)}\n`;
    expect(Buffer.byteLength(atLimit)).toBe(MAX_CONFIG_BYTES);
    expect(storedConfigText(Buffer.from(atLimit))).toBe(atLimit);
  });

  it("stores U+0000, which Postgres text refuses, as U+FFFD", () => {
    const stored = storedConfigText(Buffer.from(`version: 1${NUL}\nrules: []\n`));
    expect(stored).toBe(`version: 1${REPLACEMENT}\nrules: []\n`);
    expect(stored.includes(NUL)).toBe(false);
  });

  it("reads bytes that aren't UTF-8 as U+FFFD", () => {
    expect(storedConfigText(Uint8Array.from([0x23, 0xff, 0x0a]))).toBe(`#${REPLACEMENT}\n`);
  });

  it("cuts a file over the limit to exactly the cap, never inside a character, so it reads as too large", () => {
    // Two-byte characters straddle the cap at either parity of the cut.
    for (const prefix of ["", "x"]) {
      const text = `${prefix}${"é".repeat(MAX_CONFIG_BYTES)}`;
      const stored = storedConfigText(Buffer.from(text));
      expect(Buffer.byteLength(stored)).toBe(MAX_STORED_RULES_CONFIG_BYTES);
      expect(stored.includes(REPLACEMENT)).toBe(false);
      expect(stored.startsWith(`${prefix}éé`)).toBe(true);
      expect(parseRulesConfig(stored)).toEqual({
        ok: false,
        issues: [{ path: "", message: expect.stringMatching(/^the file is larger/) as string }],
      });
    }
  });

  it("cuts a file the replacements pushed over the limit", () => {
    // 30,000 NULs are 30,000 bytes, but 90,000 as U+FFFD.
    const stored = storedConfigText(Buffer.from(NUL.repeat(30_000)));
    expect(Buffer.byteLength(stored)).toBe(MAX_STORED_RULES_CONFIG_BYTES);
    expect(stored.endsWith(`${REPLACEMENT}  `)).toBe(true);
  });
});

describe("readRulesConfig", () => {
  it("reads the root's .gitinside.yml, or null when there's none", async () => {
    expect(await readRulesConfig(root)).toBeNull();
    await writeFile(join(root, RULES_CONFIG_FILE), "version: 1\nrules: []\n");
    expect(await readRulesConfig(root)).toBe("version: 1\nrules: []\n");
  });

  it("is null for a folder of that name, or a tree that's gone", async () => {
    await mkdir(join(root, RULES_CONFIG_FILE));
    expect(await readRulesConfig(root)).toBeNull();
    expect(await readRulesConfig(join(root, "missing"))).toBeNull();
  });

  it("doesn't follow a symlink of that name", async (test) => {
    await writeFile(join(root, "real.yml"), "version: 1\nrules: []\n");
    try {
      await symlink(join(root, "real.yml"), join(root, RULES_CONFIG_FILE), "file");
    } catch {
      // Windows without the symlink privilege; CI's Linux runs it.
      test.skip();
    }
    expect(await readRulesConfig(root)).toBeNull();
  });

  it("reads only the cap's worth of a huge file", async () => {
    await writeFile(join(root, RULES_CONFIG_FILE), "x".repeat(3 * MAX_CONFIG_BYTES));
    const text = await readRulesConfig(root);
    expect(text).toBe("x".repeat(MAX_STORED_RULES_CONFIG_BYTES));
  });
});

describe("rulesConfigOf", () => {
  it("takes the head's text, changed when it differs from the base's", async () => {
    const [a, b] = [join(root, "a"), join(root, "b")];
    await mkdir(a);
    await mkdir(b);
    expect(await rulesConfigOf(a, b)).toEqual({ text: null, changed: false });
    await writeFile(join(b, RULES_CONFIG_FILE), "version: 1\nrules: []\n");
    expect(await rulesConfigOf(a, b)).toEqual({ text: "version: 1\nrules: []\n", changed: true });
    await writeFile(join(a, RULES_CONFIG_FILE), "version: 1\nrules: []\n");
    expect(await rulesConfigOf(a, b)).toEqual({ text: "version: 1\nrules: []\n", changed: false });
    // Removed by the PR: nothing to check, but changed.
    expect(await rulesConfigOf(b, join(root, "missing"))).toEqual({ text: null, changed: true });
  });
});

describe("checkRules", () => {
  const budget = { budgetMs: 20_000 };

  it("checks nothing when the head has no config", () => {
    expect(checkRules({ text: null, changed: true }, made, budget)).toBeUndefined();
  });

  it("reports a config that doesn't parse with its issues", () => {
    expect(checkRules({ text: "version: 2\nrules: []\n", changed: true }, made, budget)).toEqual({
      result: { ok: false, issues: [{ path: "version", line: 1, message: "`version` must be 1" }] },
      configChanged: true,
    });
  });

  it("reports only the violations the PR introduces", () => {
    // Only the head's moved file is under src/orders/: its import and call are new.
    const checked = checkRules({ text: forbid("src/orders/**"), changed: false }, made, budget);
    expect(checked?.configChanged).toBe(false);
    expect(checked?.result.ok && checked.result.report.violations.map((v) => v.message)).toEqual([
      "listOrders (app) depends on formatAmount (util) through calls",
      "routes.ts (app) depends on format.ts (util) through imports",
    ]);
  });

  it("passes the diff's renames, so a violation that only moved isn't new", () => {
    const text = forbid("src/routes/**", "src/orders/**");
    const checked = checkRules({ text, changed: false }, made, budget);
    expect(checked?.result).toMatchObject({ ok: true, report: { violations: [], uncertain: [] } });
  });

  it("reports no time left as a config issue, checking nothing", () => {
    const checked = checkRules({ text: "not: [yaml", changed: false }, made, { budgetMs: 0 });
    expect(checked?.result).toEqual({
      ok: false,
      issues: [{ path: "", message: expect.stringMatching(/^no time was left/) as string }],
    });
  });

  it("gives the evaluation its clock", () => {
    let reads = 0;
    const checked = checkRules({ text: forbid("src/**"), changed: false }, made, {
      budgetMs: 1,
      now: () => ++reads,
    });
    // Too small a graph to reach the clock's next check: it finishes.
    expect(checked?.result.ok).toBe(true);
    expect(reads).toBeGreaterThan(0);
  });
});
