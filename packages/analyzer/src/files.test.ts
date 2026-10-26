import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitinside-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("module and file nodes", () => {
  it("attaches root-level files to the service and nests modules", async () => {
    await put("index.ts", "export {};");
    await put("src/routes/orders.ts", "export {};");
    await put("src/routes/deep/x.ts", "export {};");
    await put("src/a/b/leaf.ts", "export {};");
    const graph = await analyze(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("file:app/index.ts")).toMatchObject({
      kind: "file",
      parentId: "service:app/",
      path: "index.ts",
      label: "index.ts",
      hash: sha("export {};"),
    });
    expect(byId.get("module:app/src/routes")).toMatchObject({
      kind: "module",
      parentId: "service:app/",
      path: "src/routes",
      label: "routes",
    });
    expect(byId.get("module:app/src/routes/deep")?.parentId).toBe("module:app/src/routes");
    // `src/a` holds no files itself, so it gets no module.
    expect(byId.has("module:app/src/a")).toBe(false);
    expect(byId.get("file:app/src/a/b/leaf.ts")?.parentId).toBe("module:app/src/a/b");
    expect(byId.get("module:app/src/a/b")?.parentId).toBe("service:app/");
  });

  it("uses service-relative ids and repo-relative paths in workspaces", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/api/package.json", JSON.stringify({ name: "api" }));
    await put("apps/api/src/server.ts", "export const x = 1;");
    await put("apps/web/package.json", JSON.stringify({ name: "web" }));
    await put("apps/web/page.tsx", "export {};");
    const graph = await analyze(dir);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("file:api/src/server.ts")).toMatchObject({
      path: "apps/api/src/server.ts",
      parentId: "module:api/src",
    });
    expect(byId.get("module:api/src")).toMatchObject({ path: "apps/api/src" });
    expect(byId.get("file:web/page.tsx")?.parentId).toBe("service:web/");
  });

  it("changes the hash only when the content changes", async () => {
    await put("a.ts", "export const a = 1;");
    const first = await analyze(dir);
    const again = await analyze(dir);
    await put("a.ts", "export const a = 2;");
    const changed = await analyze(dir);
    const hash = (g: typeof first) => g.nodes.find((n) => n.id === "file:app/a.ts");
    expect(hash(again)).toEqual(hash(first));
    expect(hash(changed)).not.toEqual(hash(first));
  });

  it("skips files outside every package", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    await put("apps/api/package.json", JSON.stringify({ name: "api" }));
    await put("apps/api/a.ts", "export {};");
    await put("scripts/build.ts", "export {};");
    const graph = await analyze(dir);
    expect(graph.nodes.map((n) => n.id)).not.toContain("file:api/scripts/build.ts");
    expect(graph.nodes.some((n) => n.kind === "file" && n.path === "scripts/build.ts")).toBe(false);
  });
});
