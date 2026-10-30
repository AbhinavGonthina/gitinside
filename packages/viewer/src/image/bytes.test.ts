// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGraph, type ArchitectureGraph, type GraphNode } from "@gitinside/schema";
import { describe, expect, it } from "vitest";
import { renderDiagram } from "./diagram.js";

// The README image's exact bytes, pinned: an image is cached by commit, so a
// change that moves one pixel must be deliberate (M4b.3b2 moved the image off
// the prototype's model with these unchanged). Hashes of every fixture's
// golden graph and of a wrapped synthetic one, in each theme. After an
// intended change, update the hashes from the failure and say why in the commit.

const FIXTURES = join(process.cwd(), "../../fixtures");

const fixtures = readdirSync(FIXTURES)
  .filter((name) => existsSync(join(FIXTURES, name, "expected.json")))
  .sort();

const graphOf = (name: string): ArchitectureGraph =>
  parseGraph(JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8")));

/**
 * Two layers that wrap (12 datastores, 6 backend services) with lines into
 * and out of wrapped sub-columns, along a lane beside one, and in parallel
 * between one pair, which no fixture has.
 */
function wrapped(): ArchitectureGraph {
  const base = graphOf("shop-demo");
  const root: GraphNode = { id: "system:wide", kind: "system", label: "wide", parentId: null };
  const services = Array.from(
    { length: 7 },
    (_, i): GraphNode => ({
      id: `service:s${i}/`,
      kind: "service",
      label: `@wide/service-${i}`,
      parentId: root.id,
      layer: i === 0 ? "frontend" : "backend",
      root: `s${i}`,
    }),
  );
  const stores = Array.from(
    { length: 12 },
    (_, i): GraphNode => ({
      id: `datastore:infra/db${i}`,
      kind: "datastore",
      label: `db${i}`,
      parentId: root.id,
      layer: "data",
      engine: "postgres",
    }),
  );
  const edge = (from: string, to: string, kind: "calls" | "reads" | "writes") => ({
    id: `${kind}:${from}->${to}`,
    kind,
    from,
    to,
    confidence: "exact" as const,
    sites: [],
  });
  return {
    ...base,
    repo: { owner: "acme", name: "wide", sha: "0123456789abcdef0123456789abcdef01234567" },
    nodes: [root, ...services, ...stores],
    edges: [
      edge("service:s0/", "service:s3/", "calls"),
      edge("service:s1/", "service:s6/", "calls"),
      edge("service:s1/", "service:s4/", "calls"),
      edge("service:s2/", "datastore:infra/db0", "reads"),
      edge("service:s5/", "datastore:infra/db7", "writes"),
      edge("service:s6/", "datastore:infra/db11", "reads"),
      // Parallel lines between neighboring sub-columns.
      edge("service:s6/", "datastore:infra/db2", "reads"),
      edge("service:s6/", "datastore:infra/db2", "writes"),
      edge("service:s0/", "datastore:infra/db3", "reads"),
    ],
    warnings: [],
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("renderDiagram bytes", () => {
  it("draws every fixture and a wrapped graph exactly as before", () => {
    const graphs: [string, ArchitectureGraph][] = [
      ...fixtures.map((name): [string, ArchitectureGraph] => [name, graphOf(name)]),
      ["(wrapped)", wrapped()],
    ];
    const actual = Object.fromEntries(
      graphs.map(([name, graph]) => [
        name,
        (["auto", "dark", "light"] as const).map((theme) => sha(renderDiagram(graph, { theme }))),
      ]),
    );
    expect(actual).toEqual(EXPECTED);
  });
});

/** `auto`, `dark`, `light`: the first 16 hex digits of each SVG's SHA-256. */
const EXPECTED: Record<string, string[]> = {
  "(wrapped)": ["06931ccd18333938", "55c383ec9a7cb26b", "3554fde5780c809c"],
  "ambiguous-routes": ["f6fc365004c3fac0", "072e898f2475e408", "f3e83a2b18d48624"],
  "axios-baseurl-instance": ["8f9e58cbf579f118", "db7a9fd293ab190f", "87b6aa201ac04dc1"],
  "checker-crash": ["9ad3cd1ca9d2a5d3", "d1fca9dd0afd2e51", "1032d01b33fc2f77"],
  "compose-and-env": ["b6618b99ea80f918", "23ed7bbed43183c3", "37f6b284edd90c05"],
  "diff-broken-base": ["bcd4b43a268fe1d4", "8f4f6940b880d91a", "1697898c7befd3f1"],
  "diff-broken-head": ["857887a7f6f7aafb", "ad567ab1bb9a6594", "6e90d6f1aea7b8a5"],
  "diff-rename-base": ["91914401c85b3e45", "c0eb7ea5bad35329", "2a58638f769b631c"],
  "diff-rename-head": ["a53ced415c16a067", "ecee12699249acfa", "eae6dd240d0a5018"],
  "env-base-heuristic": ["a216e46368f855ac", "73491fd94efdfefc", "7f66af5403b0ff2f"],
  "express-basic": ["150630b64739a03b", "a2501be7e8df0957", "1690776ab8c727e7"],
  "express-nested-routers": ["4e1615e0d7a29102", "8d20ee57d890d141", "11cd55aa40b3f637"],
  "external-sdk": ["2482ec3f82eeabad", "3acd20df34c01c3d", "d7e32a1c0ac3281c"],
  "fake-secrets": ["48d78786e0da332c", "5068eacce485950e", "6812741c05af4972"],
  "fetch-template-literal": ["8b80d7390797ba19", "248e377451753beb", "261682dcd8866049"],
  "next-app-router": ["066275a4f8746a39", "6e60eb042b05a1ec", "7c9f3558ff0124c2"],
  "next-pages-api": ["cfc5e40c69391f0d", "7a84135e11ca8c0f", "5adb677acbeb0974"],
  "no-tsconfig": ["ca64d1e9051263e9", "69804ff099267024", "df35ae81cb864468"],
  "pnpm-monorepo": ["82d59280e3e5a2d3", "5c444436464a6145", "ef999ac25fbce5c5"],
  "prisma-relations": ["fa788ac8d8cf3cce", "2f9ca2e017f04955", "686703b2cc019fb1"],
  "queues-bullmq": ["171ff8834dc5fe07", "1da2d0e97f6b2736", "a82cb33a1ba7a479"],
  "shop-demo": ["a293bcabb8929d22", "d5cbf1bed672075b", "24c3b4e9fa0d57ac"],
  "syntax-error": ["55396ca32388bd0f", "9cb7f0340d7cb270", "7b0e096375125e04"],
  "wrapper-fetch": ["12360e06fae71333", "791e0ed4bfa41857", "f3719fe458b7bffc"],
};
