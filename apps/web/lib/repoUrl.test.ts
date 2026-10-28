import { describe, expect, it } from "vitest";
import { NOT_A_REPO_URL, parseRepoPath, parseRepoUrl } from "./repoUrl";

describe("parseRepoUrl", () => {
  it.each([
    "https://github.com/vercel/next.js",
    "http://github.com/vercel/next.js",
    "github.com/vercel/next.js",
    "www.github.com/vercel/next.js",
    "https://www.github.com/vercel/next.js/",
    "HTTPS://GitHub.com/vercel/next.js",
    "  https://github.com/vercel/next.js  ",
    "https://github.com/vercel/next.js.git",
    "https://github.com/vercel/next.js/tree/canary/packages/next",
    "https://github.com/vercel/next.js/blob/canary/README.md#L3",
    "https://github.com/vercel/next.js/pull/12",
    "https://github.com/vercel/next.js?tab=readme-ov-file",
    "https://github.com/vercel/next.js#readme",
    "git@github.com:vercel/next.js.git",
    "vercel/next.js",
    "vercel/next.js/",
  ])("reads %j as vercel/next.js", (input) => {
    expect(parseRepoUrl(input)).toEqual({ ok: true, owner: "vercel", repo: "next.js" });
  });

  it("keeps the names as typed (GitHub ignores case; the cache key is M5.6's job)", () => {
    expect(parseRepoUrl("github.com/Vercel/Next.js")).toEqual({
      ok: true,
      owner: "Vercel",
      repo: "Next.js",
    });
  });

  it.each([
    ["a/b", "a", "b"],
    ["a-b-c/x_y.z", "a-b-c", "x_y.z"],
    [`${"o".repeat(39)}/${"r".repeat(100)}`, "o".repeat(39), "r".repeat(100)],
    ["acme/.github", "acme", ".github"],
  ])("accepts the edge-of-the-rules name %j", (input, owner, repo) => {
    expect(parseRepoUrl(input)).toEqual({ ok: true, owner, repo });
  });

  it("asks for something when the field is empty", () => {
    expect(parseRepoUrl("   ")).toEqual({ ok: false, error: "Paste a GitHub repo URL first." });
  });

  it("says an account link needs the repo name", () => {
    const result = parseRepoUrl("https://github.com/vercel");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/account, not a repo/);
  });

  it.each([
    "https://gitlab.com/acme/shop",
    "https://bitbucket.org/acme/shop",
    "gitlab.com/acme/shop",
    "https://github.company.com/acme/shop",
    "https://github.com.evil.example/acme/shop",
    "https://evil.example/github.com/acme/shop",
    "https://gist.github.com/acme/abc123",
    "https://raw.githubusercontent.com/acme/shop/main/README.md",
    "ftp://github.com/acme/shop",
    "javascript:alert(1)",
    "https://user:pass@github.com/acme/shop",
    "https://github.com:8443/acme/shop",
    "https://github.com/",
    "https://github.com/settings/profile",
    "https://github.com/orgs/acme",
    "https://github.com/marketplace/actions",
    "acme",
    "acme/shop/tree",
    "-acme/shop",
    "acme-/shop",
    "ac--me/shop",
    `${"o".repeat(40)}/shop`,
    `acme/${"r".repeat(101)}`,
    "acme/..",
    "acme/.",
    "acme/sh op",
    "ac me/shop",
    "acme/shop%2F..",
    "acme\\shop",
    "https://github.com/acme/<script>",
    "not a url at all",
  ])("rejects %j", (input) => {
    expect(parseRepoUrl(input)).toEqual({ ok: false, error: NOT_A_REPO_URL });
  });
});

describe("parseRepoPath", () => {
  it("accepts route segments that follow GitHub's rules", () => {
    expect(parseRepoPath("vercel", "next.js")).toEqual({ owner: "vercel", repo: "next.js" });
  });

  it.each([
    ["settings", "profile"],
    ["acme", ".."],
    ["acme", "shop/../x"],
    ["-acme", "shop"],
    ["acme", ""],
    ["favicon.ico", "x"],
  ])("rejects %j / %j", (owner, repo) => {
    expect(parseRepoPath(owner, repo)).toBeNull();
  });

  it("does not strip .git from a route segment (only pasted clone URLs have it)", () => {
    expect(parseRepoPath("acme", "shop.git")).toEqual({ owner: "acme", repo: "shop.git" });
  });
});
