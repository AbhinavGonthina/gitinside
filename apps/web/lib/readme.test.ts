import { describe, expect, it } from "vitest";
import { readmeAlt, readmeMarkdown, readmeUrls } from "./readme";

const ORIGIN = "https://gitinside.abhinavgonthina.dev";

describe("readmeUrls", () => {
  it("points at the image routes and the repo page, never a permalink", () => {
    const urls = readmeUrls(ORIGIN, "acme", "shop.web");
    expect(urls.page).toBe(`${ORIGIN}/acme/shop.web`);
    expect(urls.badge).toBe(`${ORIGIN}/api/badge/acme/shop.web.svg`);
    expect(urls.diagram("dark")).toBe(`${ORIGIN}/api/diagram/acme/shop.web.svg?theme=dark`);
    expect(urls.diagram("light")).toBe(`${ORIGIN}/api/diagram/acme/shop.web.svg?theme=light`);
  });

  it("encodes names, so a bad row stays one path segment", () => {
    expect(readmeUrls(ORIGIN, "a/b", "c?d").page).toBe(`${ORIGIN}/a%2Fb/c%3Fd`);
  });
});

describe("readmeMarkdown", () => {
  it("gives the badge as one linked Markdown image", () => {
    expect(readmeMarkdown("badge", ORIGIN, "acme", "shop")).toBe(
      `[![Architecture of acme/shop, by GitInside](${ORIGIN}/api/badge/acme/shop.svg)](${ORIGIN}/acme/shop)\n`,
    );
  });

  it("gives the live image as a <picture> with one source per theme", () => {
    expect(readmeMarkdown("image", ORIGIN, "acme", "shop")).toBe(
      [
        `<a href="${ORIGIN}/acme/shop">`,
        "  <picture>",
        `    <source media="(prefers-color-scheme: dark)" srcset="${ORIGIN}/api/diagram/acme/shop.svg?theme=dark">`,
        `    <img alt="Architecture of acme/shop, by GitInside" src="${ORIGIN}/api/diagram/acme/shop.svg?theme=light">`,
        "  </picture>",
        "</a>",
        "",
      ].join("\n"),
    );
  });

  it("keeps hostile names inside their attribute and their alt text", () => {
    const html = readmeMarkdown("image", ORIGIN, 'x"><script>', "a&b");
    expect(html).not.toContain("<script>");
    expect(html).toContain('alt="Architecture of x&quot;&gt;&lt;script&gt;/a&amp;b, by GitInside"');
    const md = readmeMarkdown("badge", ORIGIN, "x]](javascript:", "\\[y");
    expect(md.startsWith("[![Architecture of x(javascript:/y, by GitInside](")).toBe(true);
    expect(md).toContain(`(${ORIGIN}/x%5D%5D%28javascript%3A/%5C%5By)\n`);
  });

  it("uses the same alt text for both", () => {
    expect(readmeAlt("acme", "shop")).toBe("Architecture of acme/shop, by GitInside");
  });
});
