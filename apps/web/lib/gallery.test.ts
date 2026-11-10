// @vitest-environment node
import { DEMO_PINS } from "@gitinside/db";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_GALLERY, demoCard } from "./gallery";

const DEMOS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "demos");

interface Record {
  sha: string;
  totals: { edges: number; wrong: number };
  edges: { verdict: string }[];
}

const record = (owner: string, name: string) =>
  JSON.parse(readFileSync(join(DEMOS, `${owner}__${name}.json`), "utf8")) as Record;

describe("DEMO_GALLERY", () => {
  it("is one card per demo pin, in the pins' order, linking its permalink and its images", () => {
    expect(DEMO_GALLERY.map((c) => `${c.owner}/${c.name}`)).toEqual(
      DEMO_PINS.map((p) => `${p.owner}/${p.name}`),
    );
    const [first] = DEMO_GALLERY;
    const sha = "308b27662b2f6fd4947791d61c797945c609fcbc";
    expect(first).toMatchObject({
      shortSha: "308b276",
      href: `/Mintplex-Labs/anything-llm/${sha}`,
      images: {
        dark: `/api/diagram/Mintplex-Labs/anything-llm/${sha}.svg?theme=dark`,
        light: `/api/diagram/Mintplex-Labs/anything-llm/${sha}.svg?theme=light`,
      },
    });
  });

  it("says what each pin's hand check recorded: every inferred edge checked, none wrong", () => {
    for (const card of DEMO_GALLERY) {
      const pin = DEMO_PINS.find((p) => p.owner === card.owner && p.name === card.name);
      const checked = record(card.owner, card.name);
      expect(checked.sha, card.name).toBe(pin?.sha);
      expect(card.checked, card.name).toBe(checked.totals.edges);
      expect(card.checked, card.name).toBe(checked.edges.length);
      expect(card.wrong, card.name).toBe(checked.totals.wrong);
      expect(checked.edges.filter((e) => e.verdict === "wrong").length, card.name).toBe(0);
      expect(card.about.length, card.name).toBeGreaterThan(0);
    }
  });

  it("refuses a pin it has no words for", () => {
    expect(() =>
      demoCard({ providerRepoId: 1, owner: "a", name: "b", sha: "c".repeat(40) }),
    ).toThrow("no gallery copy for a/b");
  });
});
