import { BASE_PARAM, STATE_PARAMS } from "@gitinside/viewer";
import { describe, expect, it } from "vitest";
import { DEEP_LINK_PARAMS, deepLinkQuery } from "./deepLinkQuery";

const SHA = "a".repeat(40);

describe("deepLinkQuery", () => {
  it("lists the viewer's own parameters, base first, in its order", () => {
    expect(DEEP_LINK_PARAMS).toEqual([BASE_PARAM, ...STATE_PARAMS]);
  });

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
