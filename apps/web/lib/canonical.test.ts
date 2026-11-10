// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CANONICAL_REDIRECT_CACHE_CONTROL,
  diagramSearch,
  graphSearch,
  redirectToCanonical,
} from "./canonical";

const BASE = "https://gitinside.test/api/graph/acme/shop/" + "a".repeat(40);

describe("redirectToCanonical", () => {
  it("lets a canonical URL through", () => {
    expect(redirectToCanonical(BASE, "")).toBeUndefined();
    expect(redirectToCanonical(`${BASE}?theme=dark`, "?theme=dark")).toBeUndefined();
  });

  it("sends any other query to the canonical URL with a cacheable 308", () => {
    for (const url of [`${BASE}?n=1`, `${BASE}?`, `${BASE}?theme=dark&n=2`]) {
      const response = redirectToCanonical(url, "");
      expect(response?.status, url).toBe(308);
      expect(response?.headers.get("location")).toBe(new URL(BASE).pathname);
      expect(response?.headers.get("cache-control")).toBe(CANONICAL_REDIRECT_CACHE_CONTROL);
    }
    expect(
      redirectToCanonical(`${BASE}?n=1&theme=dark`, "?theme=dark")?.headers.get("location"),
    ).toBe(`${new URL(BASE).pathname}?theme=dark`);
  });
});

describe("graphSearch", () => {
  it("keeps only this analyzer's version (ADR-0258)", () => {
    expect(graphSearch(`${BASE}?v=0.3.0&n=1`, "0.3.0")).toBe("?v=0.3.0");
    expect(graphSearch(`${BASE}?n=1&v=0.3.0`, "0.3.0")).toBe("?v=0.3.0");
    expect(graphSearch(`${BASE}?v=0.2.0`, "0.3.0")).toBe("");
    expect(graphSearch(`${BASE}?v=9.9.9`, "0.3.0")).toBe("");
    expect(graphSearch(BASE, "0.3.0")).toBe("");
  });
});

describe("diagramSearch", () => {
  it("keeps only a dark or light theme", () => {
    const url = "https://gitinside.test/api/diagram/acme/shop.svg";
    expect(diagramSearch(`${url}?theme=dark&x=1`)).toBe("?theme=dark");
    expect(diagramSearch(`${url}?x=1&theme=light`)).toBe("?theme=light");
    expect(diagramSearch(`${url}?theme=auto`)).toBe("");
    expect(diagramSearch(url)).toBe("");
  });
});
