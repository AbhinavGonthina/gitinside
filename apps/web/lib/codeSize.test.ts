// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createCodeSizeCache, findTooMuchCode, MAX_GITHUB_CODE_BYTES } from "./codeSize";
import { fakeGitHub } from "./github.testkit";
import { tooMuchCodeMessage, tooMuchCodeReason } from "./jobs";
import { NBSP, SUPPORTED_SOURCE_MB } from "./limits";

const SHA = "d".repeat(40);
const SHOP = { id: 42, owner: "Acme", name: "Shop", sha: SHA };
const REPO = { providerRepoId: 42, owner: "Acme", name: "Shop", sha: SHA };
const MIB = 1024 * 1024;

describe("findTooMuchCode", () => {
  it("is twice the analyzer's source-size limit", () => {
    expect(MAX_GITHUB_CODE_BYTES).toBe(2 * SUPPORTED_SOURCE_MB * MIB);
  });

  it("refuses over the limit with GitHub's count, allows up to it", async () => {
    const over = fakeGitHub([
      { ...SHOP, languages: { TypeScript: MAX_GITHUB_CODE_BYTES, JavaScript: 1 } },
    ]);
    expect(await findTooMuchCode(REPO, { fetch: over.fetch })).toBe(MAX_GITHUB_CODE_BYTES + 1);
    const at = fakeGitHub([
      { ...SHOP, languages: { TypeScript: MAX_GITHUB_CODE_BYTES - 1, JavaScript: 1, CSS: 9 } },
    ]);
    expect(await findTooMuchCode(REPO, { fetch: at.fetch })).toBeUndefined();
  });

  it("VS Code's count (2026-10-31) is refused, cal.com's isn't", async () => {
    const vscode = fakeGitHub([
      { ...SHOP, languages: { TypeScript: 220_594_269, JavaScript: 1_159_274 } },
    ]);
    expect(await findTooMuchCode(REPO, { fetch: vscode.fetch })).toBe(221_753_543);
    const calcom = fakeGitHub([
      { ...SHOP, languages: { TypeScript: 18_045_279, JavaScript: 53_265 } },
    ]);
    expect(await findTooMuchCode(REPO, { fetch: calcom.fetch })).toBeUndefined();
  });

  it("doesn't refuse when GitHub's count is unknown, and asks again next time", async () => {
    const gh = fakeGitHub([{ ...SHOP, languages: { TypeScript: MAX_GITHUB_CODE_BYTES + 1 } }]);
    const cache = createCodeSizeCache();
    gh.failNext(new Response("", { status: 502 }));
    expect(await findTooMuchCode(REPO, { fetch: gh.fetch }, cache)).toBeUndefined();
    expect(await findTooMuchCode(REPO, { fetch: gh.fetch }, cache)).toBe(MAX_GITHUB_CODE_BYTES + 1);
    expect(gh.requests).toHaveLength(2);
  });

  it("remembers a known count per repo and commit", async () => {
    const repo = { ...SHOP, languages: { TypeScript: MAX_GITHUB_CODE_BYTES + 1 } };
    const gh = fakeGitHub([repo]);
    const cache = createCodeSizeCache();
    const options = { fetch: gh.fetch };
    expect(await findTooMuchCode(REPO, options, cache)).toBe(MAX_GITHUB_CODE_BYTES + 1);
    expect(await findTooMuchCode(REPO, options, cache)).toBe(MAX_GITHUB_CODE_BYTES + 1);
    expect(gh.requests).toHaveLength(1);
    // A new commit is counted again.
    repo.languages = { TypeScript: 10 };
    expect(await findTooMuchCode({ ...REPO, sha: "e".repeat(40) }, options, cache)).toBeUndefined();
    expect(gh.requests).toHaveLength(2);
  });
});

describe("createCodeSizeCache", () => {
  it("drops the oldest entry past its size", () => {
    const cache = createCodeSizeCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3); // a is now the newest
    cache.set("c", 4);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([3, undefined, 4]);
  });
});

describe("tooMuchCodeMessage", () => {
  it("says GitHub's count, the supported size, and what to do", () => {
    expect(tooMuchCodeReason(221_753_543)).toBe(
      `GitHub counts over 211${NBSP}MB of TypeScript and JavaScript in this repo. GitInside analyzes repos up to 20,000 source files and 50${NBSP}MB of source code.`,
    );
    const message = tooMuchCodeMessage(2_000 * MIB + 1);
    expect(message.startsWith(`GitHub counts over 2,000${NBSP}MB of `)).toBe(true);
    expect(message.endsWith(" source code. Try a smaller repo.")).toBe(true);
  });
});
