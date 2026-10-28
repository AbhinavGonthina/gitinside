import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { labelFileName, type EvalRepo, type LabeledEdge, type LabelFile } from "./format.js";
import { loadEvalInputs } from "./inputs.js";
import {
  callSites,
  drawReviewSample,
  hashSeed,
  mulberry32,
  permalink,
  renderReviewSample,
  seededShuffle,
} from "./sample.js";

const repo = (owner: string, name: string): EvalRepo => ({
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  sha: "a".repeat(40),
  license: "MIT",
  shape: "spa-plus-express",
  why: "test",
});

const edge = (file: string, line: number, route: string | null): LabeledEdge => ({
  callSite: { file, line },
  method: "GET",
  target: route ? { file: "api/routes.ts", line: 3, route } : null,
});

const labelFile = (name: string, edges: LabeledEdge[]): LabelFile => ({
  repo: name,
  sha: "a".repeat(40),
  labeler: "claude-draft",
  reviewedBy: null,
  scope: ["."],
  edges,
});

/** A label file with `n` single-label call sites at web/api.ts lines 1..n. */
const sites = (name: string, n: number): LabelFile =>
  labelFile(
    name,
    Array.from({ length: n }, (_, i) => edge("web/api.ts", i + 1, null)),
  );

describe("seeded randomness", () => {
  it("hashes seeds with FNV-1a", () => {
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("a")).toBe(0xe40c292c);
  });

  it("generates the same numbers in [0, 1) for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 100 }, () => a());
    expect(Array.from({ length: 100 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBe(100);
  });

  it("shuffles a copy into a seed-determined permutation", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const once = seededShuffle(items, "2026-10-28");
    expect(seededShuffle(items, "2026-10-28")).toEqual(once);
    expect([...once].sort((x, y) => x - y)).toEqual(items);
    expect(once).not.toEqual(items);
    expect(seededShuffle(items, "2026-10-29")).not.toEqual(once);
    expect(items[0]).toBe(0);
  });
});

describe("callSites", () => {
  it("groups the labels of one call site", () => {
    const file = labelFile("acme/shop", [
      edge("web/a.ts", 4, "GET /api/a"),
      edge("web/a.ts", 4, "GET /api/b"),
      edge("web/a.ts", 9, null),
    ]);
    expect(callSites(file).map((s) => [s.callSite.line, s.labels.length])).toEqual([
      [4, 2],
      [9, 1],
    ]);
  });
});

describe("drawReviewSample", () => {
  const entries = [
    { repo: repo("acme", "shop"), labels: sites("acme/shop", 49) },
    { repo: repo("beta", "blog"), labels: sites("beta/blog", 8) },
    { repo: repo("gamma", "none"), labels: sites("gamma/none", 0) },
  ];

  it("takes 20% of each repo's call sites, rounded up, sorted by call site", () => {
    const sample = drawReviewSample(entries, "2026-10-28");
    expect(sample.map((s) => [s.total, s.sites.length])).toEqual([
      [49, 10],
      [8, 2],
      [0, 0],
    ]);
    const lines = sample[0]?.sites.map((s) => s.callSite.line) ?? [];
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(lines).size).toBe(10);
  });

  it("is reproducible from the seed, and a repo's sample ignores the other repos", () => {
    const first = drawReviewSample(entries, "2026-10-28");
    expect(drawReviewSample(entries, "2026-10-28")).toEqual(first);
    expect(drawReviewSample(entries.slice(0, 1), "2026-10-28")[0]).toEqual(first[0]);
    expect(drawReviewSample(entries, "2026-11-02")[0]).not.toEqual(first[0]);
  });

  it("keeps every label of a sampled multi-route site", () => {
    const file = labelFile("acme/shop", [
      edge("web/a.ts", 4, "GET /api/a"),
      edge("web/a.ts", 4, "GET /api/b"),
    ]);
    const [only] = drawReviewSample([{ repo: repo("acme", "shop"), labels: file }], "x");
    expect(only?.sites[0]?.labels).toHaveLength(2);
  });

  it("samples the committed labels: at least one site per repo, ⌈20%⌉ each", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const inputs = loadEvalInputs(root);
    const committed = inputs.repos.map((r) => ({
      repo: r,
      labels: inputs.labels.get(labelFileName(r.owner, r.name)) as LabelFile,
    }));
    for (const s of drawReviewSample(committed, "2026-10-28")) {
      expect(s.sites.length).toBe(Math.ceil(s.total * 0.2));
      expect(s.sites.length).toBeGreaterThan(0);
    }
  });
});

describe("renderReviewSample", () => {
  it("links call sites and routes at the pinned SHA, escaping route-group folders", () => {
    const r = repo("acme", "shop");
    expect(permalink(r, "app/(marketing)/[id]/page.tsx", 7)).toBe(
      `https://github.com/acme/shop/blob/${"a".repeat(40)}/app/%28marketing%29/%5Bid%5D/page.tsx#L7`,
    );
  });

  it("renders one checkbox per call site, nesting multi-route sites", () => {
    const multi: LabeledEdge[] = [
      { ...edge("web/a.ts", 4, "GET /api/a"), notes: "ternary" },
      edge("web/a.ts", 4, "GET /api/b"),
    ];
    const text = renderReviewSample(
      [
        {
          repo: repo("zeta", "z"),
          total: 3,
          sites: [
            {
              callSite: { file: "x.ts", line: 2, column: 5 },
              labels: [{ ...edge("x.ts", 2, null), method: null }],
            },
          ],
        },
        {
          repo: repo("acme", "shop"),
          total: 5,
          sites: [{ callSite: { file: "web/a.ts", line: 4 }, labels: multi }],
        },
      ],
      "2026-10-28",
    );
    const url = (o: string, n: string, path: string): string =>
      `https://github.com/${o}/${n}/blob/${"a".repeat(40)}/${path}`;
    expect(text).toBe(
      [
        "Seed `2026-10-28`: 2 of 8 call sites (20% of each repo, rounded up).",
        "",
        "### acme/shop (1 of 5, `aaaaaaa`)",
        "",
        `- [ ] [\`web/a.ts:4\`](${url("acme", "shop", "web/a.ts#L4")}): reaches 2 routes`,
        `  - \`GET\` → [\`GET /api/a\`](${url("acme", "shop", "api/routes.ts#L3")}). ternary`,
        `  - \`GET\` → [\`GET /api/b\`](${url("acme", "shop", "api/routes.ts#L3")})`,
        "",
        "### zeta/z (1 of 3, `aaaaaaa`)",
        "",
        `- [ ] [\`x.ts:2:5\`](${url("zeta", "z", "x.ts#L2")}): \`(method computed at runtime)\` → **no route in this repo** (external host or unknowable URL)`,
        "",
      ].join("\n"),
    );
  });
});
