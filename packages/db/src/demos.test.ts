import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_PINS, findDemoPin } from "./demos.js";

const REPOS_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "demos",
  "repos.json",
);

describe("DEMO_PINS", () => {
  it("are docs/demos/repos.json's picks, in its order, at their checked commits", () => {
    const picked = (
      JSON.parse(readFileSync(REPOS_JSON, "utf8")) as {
        repos: { owner: string; name: string; sha: string }[];
      }
    ).repos.map(({ owner, name, sha }) => ({ owner, name, sha }));
    expect(DEMO_PINS.map(({ owner, name, sha }) => ({ owner, name, sha }))).toEqual(picked);
  });

  it("name each repo by a GitHub ID and a full lowercase SHA, each once", () => {
    for (const pin of DEMO_PINS) {
      expect(Number.isSafeInteger(pin.providerRepoId) && pin.providerRepoId > 0).toBe(true);
      expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(new Set(DEMO_PINS.map((p) => p.providerRepoId)).size).toBe(DEMO_PINS.length);
  });
});

describe("findDemoPin", () => {
  const pin = { providerRepoId: 7, owner: "Acme", name: "Shop", sha: "a".repeat(40) };

  it("finds a pin by name, ignoring case, and its exact commit", () => {
    expect(findDemoPin({ owner: "acme", name: "SHOP", sha: "a".repeat(40) }, [pin])).toBe(pin);
    expect(findDemoPin({ owner: "Acme", name: "Shop", sha: "b".repeat(40) }, [pin])).toBe(
      undefined,
    );
    expect(findDemoPin({ owner: "Acme", name: "Shop", sha: "A".repeat(40) }, [pin])).toBe(
      undefined,
    );
    expect(findDemoPin({ owner: "Acme", name: "Shop2", sha: "a".repeat(40) }, [pin])).toBe(
      undefined,
    );
    expect(findDemoPin({ owner: "Acm", name: "Shop", sha: "a".repeat(40) }, [pin])).toBe(undefined);
  });

  it("knows the real pins by default", () => {
    const [first] = DEMO_PINS;
    expect(first && findDemoPin({ owner: first.owner, name: first.name, sha: first.sha })).toBe(
      first,
    );
  });
});
