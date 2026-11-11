import { describe, expect, it } from "vitest";
import { deepLinkQuery, IGNORED_NAMED, ignoredNote, shareUrl } from "./deepLink";

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

describe("deepLinkQuery", () => {
  it("keeps only a deep link's parameters, base first then the explorer's order", () => {
    expect(
      deepLinkQuery({ step: "2", fresh: "1", trace: "route:api/GET /x", base: SHA, open: "web/" }),
    ).toBe(`base=${SHA}&open=web/&trace=route:api/GET%20/x&step=2`);
    expect(deepLinkQuery({ utm_source: "x", commit: SHA })).toBe("");
    expect(deepLinkQuery({})).toBe("");
  });

  it("keeps each value of a repeated one, and escapes what would split the query", () => {
    expect(deepLinkQuery({ sel: ["a&b=c", "d%e"], open: [] })).toBe("sel=a%26b%3Dc&sel=d%25e");
  });

  it("reads back as the same state in the explorer", () => {
    const query = deepLinkQuery({ open: "service:api/,service:web/", sel: "route:api/GET /a b" });
    const params = new URLSearchParams(query);
    expect(params.get("open")).toBe("service:api/,service:web/");
    expect(params.get("sel")).toBe("route:api/GET /a b");
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

  it("names an unknown diff view in words (M6.9e2b)", () => {
    expect(ignoredNote([{ param: "view", value: "split" }], SHA)).toMatch(
      /left out: diff view split\.$/,
    );
  });

  it("falls back to the parameter's own name", () => {
    expect(ignoredNote([{ param: "odd", value: "x" }], SHA)).toMatch(/left out: odd x\.$/);
  });
});
