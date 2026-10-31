import { describe, expect, it } from "vitest";
import { IGNORED_NAMED, ignoredNote, shareUrl } from "./deepLink";

const SHA = "a".repeat(40);

describe("shareUrl", () => {
  it("is the commit's permalink with the state, or just the permalink", () => {
    expect(shareUrl("https://x.test", "acme", "shop", SHA, "sel=service:api/")).toBe(
      `https://x.test/acme/shop/${SHA}?sel=service:api/`,
    );
    expect(shareUrl("https://x.test", "acme", "shop", SHA, "")).toBe(
      `https://x.test/acme/shop/${SHA}`,
    );
  });
});

describe("ignoredNote", () => {
  it("is nothing when the whole link applies", () => {
    expect(ignoredNote([], SHA)).toBeUndefined();
  });

  it("names what was left out, in words, at the short commit", () => {
    expect(
      ignoredNote(
        [
          { param: "sel", value: "route:api/GET /old" },
          { param: "step", value: "9" },
        ],
        SHA,
      ),
    ).toBe(
      "Part of this link doesn't apply to commit aaaaaaa, so it was left out: selected route:api/GET /old; step 9.",
    );
  });

  it(`names ${IGNORED_NAMED} parts at most and counts the rest`, () => {
    const ignored = ["a/", "b/", "c/", "d/", "e/"].map((value) => ({ param: "open", value }));
    expect(ignoredNote(ignored, SHA)).toBe(
      "Part of this link doesn't apply to commit aaaaaaa, so it was left out: broken down a/; broken down b/; broken down c/; and 2 more.",
    );
  });

  it("falls back to the parameter's own name", () => {
    expect(ignoredNote([{ param: "odd", value: "x" }], SHA)).toMatch(/left out: odd x\.$/);
  });
});
