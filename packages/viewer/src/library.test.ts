// @vitest-environment node
// (No DOM needed, and jsdom's URL rejects the file: URLs used below.)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

const src = fileURLToPath(new URL(".", import.meta.url));

/** Every `elkjs/…` module the library's own (non-test) sources import. */
function elkImports(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|testkit|stories)\.tsx?$/.test(entry.name))
        for (const m of readFileSync(path, "utf8").matchAll(/["'](elkjs\/[^"']+)["']/g))
          found.add(m[1]!);
    }
  };
  walk(src);
  return [...found].sort();
}

describe("the library build", () => {
  it("leaves elkjs to the app's bundler, as it ships (M10.3e3, ADR-0288)", () => {
    // Bundled, ELK's 48k-line build became a dist chunk that the app's vitest transformed on
    // first use: 4 s here, 13 s on a busy CI runner, where Node loads the package as is.
    const external = config.build?.rollupOptions?.external;
    if (!Array.isArray(external)) throw new Error("external isn't a list");
    const isExternal = (id: string) =>
      external.some((rule) => (typeof rule === "string" ? rule === id : rule.test(id)));
    const imports = elkImports();
    expect(imports).toEqual([
      "elkjs/lib/elk-api.js",
      "elkjs/lib/elk-worker.min.js",
      "elkjs/lib/elk.bundled.js",
    ]);
    for (const id of imports) expect(isExternal(id), id).toBe(true);
  });
});
