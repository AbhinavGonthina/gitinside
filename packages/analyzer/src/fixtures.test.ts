import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@gitinside/schema";
import { analyze } from "./analyze.js";
import { serializeGraph } from "./assemble.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

/** Analyze `fixtures/<name>` with a fixed repo identity so goldens don't depend on the checkout path. */
async function run(name: string): Promise<ArchitectureGraph> {
  return analyze(join(FIXTURES, name), { owner: "fixtures", name });
}

const NAMES = [
  "express-basic",
  "express-nested-routers",
  "next-app-router",
  "next-pages-api",
  "prisma-relations",
  "pnpm-monorepo",
  "syntax-error",
  "no-tsconfig",
];

describe.each(NAMES)("fixture %s", (name) => {
  it("matches expected.json byte for byte", async () => {
    const text = serializeGraph(await run(name));
    const goldenPath = join(FIXTURES, name, "expected.json");
    if (process.env.UPDATE_GOLDEN === "1") await writeFile(goldenPath, text);
    expect(text).toBe(await readFile(goldenPath, "utf8"));
  });
});

/** Ids of nodes of one kind. */
function ids(graph: ArchitectureGraph, kind: string): string[] {
  return graph.nodes.filter((n) => n.kind === kind).map((n) => n.id);
}

describe("fixture contents (guards against blindly regenerated goldens)", () => {
  it("express-basic finds three routes; imported handlers get handles edges", async () => {
    const g = await run("express-basic");
    expect(ids(g, "route")).toHaveLength(3);
    // The inline /health handler has no symbol to link; the two imported ones do.
    expect(g.edges.filter((e) => e.kind === "handles")).toHaveLength(2);
  });

  it("express-nested-routers composes mount prefixes", async () => {
    const g = await run("express-nested-routers");
    const routes = ids(g, "route").join("\n");
    expect(routes).toContain("/api/ping");
    expect(routes).toContain("/api/orders/:id");
  });

  it("next-app-router strips route groups and keeps dynamic segments", async () => {
    const g = await run("next-app-router");
    const all = [...ids(g, "route"), ...ids(g, "page")].join("\n");
    expect(all).toContain("/products/:id");
    expect(all).not.toContain("(shop)");
    expect(ids(g, "route").filter((id) => id.includes("/api/items"))).toHaveLength(2);
  });

  it("next-pages-api finds the pages and API routes", async () => {
    const g = await run("next-pages-api");
    expect(ids(g, "route").join("\n")).toContain("/api/hello");
    expect(ids(g, "route").join("\n")).toContain("/api/echo/:id");
    expect(ids(g, "page").length).toBeGreaterThanOrEqual(1);
  });

  it("prisma-relations finds models, a datastore, and an unresolved raw query", async () => {
    const g = await run("prisma-relations");
    expect(ids(g, "model")).toHaveLength(2);
    expect(ids(g, "datastore")).toHaveLength(1);
    expect(g.nodes.some((n) => n.kind === "unresolved" && n.reason === "RAW_QUERY")).toBe(true);
    expect(g.edges.some((e) => e.kind === "reads")).toBe(true);
    expect(g.edges.some((e) => e.kind === "writes")).toBe(true);
  });

  it("pnpm-monorepo has two services and a cross-service import", async () => {
    const g = await run("pnpm-monorepo");
    expect(ids(g, "service")).toHaveLength(2);
    expect(g.edges.some((e) => e.kind === "imports" && e.to.includes("shared"))).toBe(true);
  });

  it("syntax-error still analyzes and warns", async () => {
    const g = await run("syntax-error");
    expect(g.warnings.some((w) => w.code === "SYNTAX_ERROR")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "symbol" && n.label === "fine")).toBe(true);
  });

  it("no-tsconfig resolves the CommonJS require", async () => {
    const g = await run("no-tsconfig");
    expect(g.warnings.some((w) => w.code === "TSCONFIG_MISSING")).toBe(true);
    expect(g.edges.some((e) => e.kind === "imports")).toBe(true);
  });
});
