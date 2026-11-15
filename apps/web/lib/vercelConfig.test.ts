// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Vercel's ignored build step (ADR-0297): `apps/web/vercel.json` skips a deployment when nothing
 * `@gitinside/web` builds from changed, so docs, eval, bench, and infra commits don't spend
 * Hobby's 100 deployments a day. turbo-ignore asks turbo which packages changed, so these tests
 * also hold turbo's view of the repo to what the website's build reads.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = (path: string) => readFileSync(join(ROOT, path), "utf8");
const json = <T>(path: string): T => JSON.parse(text(path)) as T;

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const vercel = json<{ ignoreCommand?: string; buildCommand?: string }>("apps/web/vercel.json");
const web = json<PackageJson>("apps/web/package.json");
const turbo = json<{ globalDependencies?: string[] }>("turbo.json");

/** Every workspace package's folder (repo-relative, `/`-separated) by name. */
function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  const folders = text("pnpm-workspace.yaml")
    .split("\n")
    .map((line) => /^\s*-\s*"([^"]+)"/.exec(line)?.[1])
    .filter((glob): glob is string => glob !== undefined)
    .flatMap((glob) =>
      glob.endsWith("/*")
        ? readdirSync(join(ROOT, glob.slice(0, -2))).map((d) => `${glob.slice(0, -2)}/${d}`)
        : [glob],
    );
  for (const folder of folders) {
    if (existsSync(join(ROOT, folder, "package.json"))) {
      dirs.set(json<PackageJson>(`${folder}/package.json`).name, folder);
    }
  }
  return dirs;
}

/** `@gitinside/web` and every workspace package it depends on, directly or not. */
function webAndDependencies(): string[] {
  const dirs = workspaceDirs();
  const seen = new Set<string>();
  const visit = (name: string) => {
    const dir = dirs.get(name);
    if (dir === undefined || seen.has(dir)) return;
    seen.add(dir);
    const pkg = json<PackageJson>(`${dir}/package.json`);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) visit(dep);
  };
  visit(web.name);
  return [...seen].sort();
}

/** The files a package's tsconfigs extend from outside the package (repo-relative). */
function extendedFromOutside(dir: string): string[] {
  const found = new Set<string>();
  const follow = (file: string) => {
    // tsconfig allows comments; these files have none, so plain JSON is enough here.
    const config = JSON.parse(readFileSync(file, "utf8")) as { extends?: string | string[] };
    const parents = config.extends === undefined ? [] : [config.extends].flat();
    for (const parent of parents.filter((p) => p.startsWith("."))) {
      const path = resolve(dirname(file), parent);
      const rel = relative(join(ROOT, dir), path);
      if (rel.startsWith("..")) found.add(relative(ROOT, path).split(sep).join("/"));
      follow(path);
    }
  };
  for (const name of readdirSync(join(ROOT, dir))) {
    if (/^tsconfig.*\.json$/.test(name)) follow(join(ROOT, dir, name));
  }
  return [...found];
}

describe("Vercel's ignored build step", () => {
  it("asks turbo-ignore, at a pinned version, whether the web package changed", () => {
    expect(web.name).toBe("@gitinside/web");
    expect(vercel.ignoreCommand).toBe(`npx -y turbo-ignore@2.11.11 ${web.name}`);
  });

  it("builds a branch's first deployment rather than guessing what it changed", () => {
    // Without a fallback, a branch with no earlier deployment always builds. `--fallback=HEAD^`
    // would compare only the last commit, and skip a first push whose website change is in an
    // earlier commit.
    expect(vercel.ignoreCommand).not.toMatch(/--fallback/);
  });

  it("builds the same package turbo-ignore asks about", () => {
    expect(vercel.buildCommand).toContain(`--filter=${web.name}`);
  });

  it("pins turbo exactly, since turbo-ignore runs the root's turbo version through npx", () => {
    const root = json<PackageJson>("package.json");
    expect(root.devDependencies?.turbo).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("counts every file outside a package that the website's packages build from", () => {
    // turbo ignores a change outside every package unless it's a global dependency, so a
    // tsconfig.base.json edit alone would skip a build that typechecks against it.
    const dirs = webAndDependencies();
    expect(dirs).toContain("apps/web");
    const outside = [...new Set(dirs.flatMap(extendedFromOutside))].sort();
    expect(outside).toEqual(["tsconfig.base.json"]);
    expect(turbo.globalDependencies ?? []).toEqual(
      expect.arrayContaining([...outside, "pnpm-workspace.yaml"]),
    );
  });
});
