import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStrings } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { EvalInputError, REPO_SHAPES, type EvalRepo, type LabelFile } from "./format.js";
import { crossCheck, loadEvalInputs } from "./inputs.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const repo: EvalRepo = {
  owner: "acme",
  name: "shop",
  url: "https://github.com/acme/shop",
  sha: SHA_A,
  license: "MIT",
  shape: "spa-plus-express",
  why: "React SPA calling its Express API.",
};

const labels = (repoName: string, sha: string): LabelFile => ({
  repo: repoName,
  sha,
  labeler: "claude-draft",
  reviewedBy: null,
  scope: ["."],
  edges: [],
});

describe("crossCheck", () => {
  it("accepts matching labels and pinned repos without labels yet", () => {
    const inputs = {
      repos: [repo],
      labels: new Map([["acme__shop.json", labels("acme/shop", SHA_A)]]),
    };
    expect(crossCheck(inputs)).toEqual([]);
    expect(crossCheck({ repos: [repo], labels: new Map() })).toEqual([]);
  });

  it("flags wrong file names, unpinned repos, and SHA mismatches, sorted", () => {
    const inputs = {
      repos: [repo],
      labels: new Map([
        ["zeta.json", labels("acme/shop", SHA_A)],
        ["acme__shop.json", labels("acme/shop", SHA_B)],
        ["other__x.json", labels("other/x", SHA_A)],
      ]),
    };
    expect(crossCheck(inputs)).toEqual([
      `labels/acme__shop.json: labeled at ${SHA_B}, but repos.json pins ${SHA_A}`,
      "labels/other__x.json: other/x is not pinned in repos.json",
      "labels/zeta.json: repo acme/shop belongs in labels/acme__shop.json",
    ]);
  });
});

describe("loadEvalInputs", () => {
  function scratch(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "gitinside-eval-"));
    mkdirSync(join(root, "labels"));
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    return root;
  }

  it("loads repos and only the .json label files", () => {
    const root = scratch({
      "repos.json": JSON.stringify({ repos: [repo] }),
      "labels/acme__shop.json": JSON.stringify(labels("acme/shop", SHA_A)),
      "labels/README.md": "# notes",
    });
    const inputs = loadEvalInputs(root);
    expect(inputs.repos).toEqual([repo]);
    expect([...inputs.labels.keys()]).toEqual(["acme__shop.json"]);
  });

  it("names the failing label file", () => {
    const root = scratch({
      "repos.json": '{ "repos": [] }',
      "labels/acme__shop.json": JSON.stringify({ ...labels("acme/shop", SHA_A), scope: [] }),
    });
    expect(() => loadEvalInputs(root)).toThrow(EvalInputError);
    expect(() => loadEvalInputs(root)).toThrow(/^labels\/acme__shop\.json:/);
  });

  it("validates the committed eval inputs", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    expect(crossCheck(loadEvalInputs(root))).toEqual([]);
  });

  it("pins one committed repo per shape (EVALUATION.md §1)", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const shapes = loadEvalInputs(root)
      .repos.map((r) => r.shape)
      .sort(compareStrings);
    expect(shapes).toEqual([...REPO_SHAPES]);
  });
});
