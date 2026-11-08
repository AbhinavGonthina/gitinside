// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fetchCodeBytes, resolveRepo, resolveRepoById, resolveSeenRepo } from "./github";
import { fakeGitHub, type FakeGitHub } from "./github.testkit";

const SHA = "d".repeat(40);
const SHOP = {
  id: 42,
  owner: "Acme",
  name: "Shop",
  sha: SHA,
  defaultBranch: "trunk",
  sizeKb: 2_048,
};

describe("resolveRepo", () => {
  it("returns GitHub's facts and the default branch's head", async () => {
    const gh = fakeGitHub([SHOP]);
    const result = await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch });
    expect(result).toEqual({
      ok: true,
      repo: {
        providerRepoId: 42,
        owner: "Acme",
        name: "Shop",
        visibility: "public",
        defaultBranch: "trunk",
        sha: SHA,
        sizeKb: 2_048,
      },
    });
    expect(gh.requests.map((r) => [r.url, r.accept])).toEqual([
      ["https://api.github.com/repos/acme/shop", "application/vnd.github+json"],
      ["https://api.github.com/repos/Acme/Shop/commits/HEAD", "application/vnd.github.sha"],
    ]);
  });

  it("sends the token only when one is configured", async () => {
    const gh = fakeGitHub([SHOP]);
    await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch });
    await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch, token: "t0ken" });
    expect(gh.requests.map((r) => r.authorization)).toEqual([
      null,
      null,
      "Bearer t0ken",
      "Bearer t0ken",
    ]);
  });

  it("reports a private repo exactly like a missing one", async () => {
    const gh = fakeGitHub([{ ...SHOP, private: true }]);
    const opts = { fetch: gh.fetch };
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, opts)).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
    expect(await resolveRepo({ owner: "acme", repo: "nope" }, opts)).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
    // The private repo's commits were never asked for.
    expect(gh.requests).toHaveLength(2);
  });

  it("leaves the size out when GitHub's isn't a whole number of KiB in range", async () => {
    for (const size of [null, "5", -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const gh = fakeGitHub([SHOP]);
      gh.failNext(
        Response.json({
          id: 42,
          name: "Shop",
          private: false,
          default_branch: "trunk",
          owner: { login: "Acme" },
          size,
        }),
      );
      const result = await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch });
      expect(result.ok && result.repo).toMatchObject({ providerRepoId: 42, sha: SHA });
      expect(result.ok && "sizeKb" in result.repo).toBe(false);
    }
    const gh = fakeGitHub([{ ...SHOP, sizeKb: 0 }]);
    const empty = await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch });
    expect(empty.ok && empty.repo.sizeKb).toBe(0);
  });

  it("an empty repo is REPO_EMPTY", async () => {
    const gh = fakeGitHub([{ ...SHOP, sha: null }]);
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_EMPTY",
    });
  });

  it("follows a rename inside the API, and nothing else", async () => {
    const gh = fakeGitHub([SHOP]);
    const moved = () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/acme/shop" },
      });
    gh.failNext(moved());
    const renamed = await resolveRepo({ owner: "acme", repo: "old-shop" }, { fetch: gh.fetch });
    expect(renamed.ok).toBe(true);

    gh.failNext(
      new Response(null, { status: 301, headers: { location: "https://evil.example/x" } }),
    );
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
    gh.failNext(new Response(null, { status: 302 }));
    expect((await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).ok).toBe(
      false,
    );
    gh.failNext(new Response(null, { status: 302, headers: { location: "http://[" } }));
    expect((await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).ok).toBe(
      false,
    );

    for (let i = 0; i < 4; i++) gh.failNext(moved());
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
  });

  it("maps GitHub's failures", async () => {
    const cases: [Response | Error, string][] = [
      [new Response("", { status: 451 }), "REPO_UNAVAILABLE"],
      [
        new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
        "GITHUB_RATE_LIMITED",
      ],
      [new Response("", { status: 429, headers: { "retry-after": "30" } }), "GITHUB_RATE_LIMITED"],
      [new Response("", { status: 403 }), "GITHUB_UNAVAILABLE"],
      [new Response("", { status: 502 }), "GITHUB_UNAVAILABLE"],
      [new TypeError("fetch failed"), "GITHUB_UNAVAILABLE"],
      [new Response("{not json"), "GITHUB_UNAVAILABLE"],
      [Response.json({ id: 1, name: "x" }), "GITHUB_UNAVAILABLE"],
      [
        Response.json({
          ...{ id: -1, name: "x", private: false, default_branch: "main" },
          owner: { login: "a" },
        }),
        "GITHUB_UNAVAILABLE",
      ],
      [
        Response.json({
          id: 1,
          name: "x",
          private: "no",
          default_branch: "main",
          owner: { login: "a" },
        }),
        "GITHUB_UNAVAILABLE",
      ],
      [
        Response.json({
          id: 1,
          name: "x",
          private: false,
          default_branch: "",
          owner: { login: "a" },
        }),
        "GITHUB_UNAVAILABLE",
      ],
      [
        Response.json({
          id: 1,
          name: "../x",
          private: false,
          default_branch: "main",
          owner: { login: "a" },
        }),
        "GITHUB_UNAVAILABLE",
      ],
      [
        Response.json({
          id: 1,
          name: "x",
          private: false,
          default_branch: "main",
          owner: { login: "-a" },
        }),
        "GITHUB_UNAVAILABLE",
      ],
      [Response.json([]), "GITHUB_UNAVAILABLE"],
    ];
    for (const [response, code] of cases) {
      const gh = fakeGitHub([SHOP]);
      gh.failNext(response);
      expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
        ok: false,
        code,
      });
    }
  });

  it("a malformed commit answer is GITHUB_UNAVAILABLE", async () => {
    const gh = fakeGitHub([{ ...SHOP, sha: "not-a-sha" }]);
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "GITHUB_UNAVAILABLE",
    });
  });

  it("a body that breaks mid-read is GITHUB_UNAVAILABLE", async () => {
    const gh = fakeGitHub([SHOP]);
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("reset"));
      },
    });
    gh.failNext(new Response(broken));
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "GITHUB_UNAVAILABLE",
    });
  });

  it("an oversized repo description isn't parsed", async () => {
    const gh = fakeGitHub([SHOP]);
    gh.failNext(new Response(" ".repeat(1024 * 1024 + 1)));
    expect(await resolveRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "GITHUB_UNAVAILABLE",
    });
  });

  it("keeps an API base's path prefix", async () => {
    const gh = fakeGitHub([]);
    await resolveRepo(
      { owner: "acme", repo: "shop" },
      { fetch: gh.fetch, apiBase: "https://ghe.example/api/v3/" },
    );
    expect(gh.requests[0]?.url).toBe("https://ghe.example/api/v3/repos/acme/shop");
  });
});

describe("resolveRepoById", () => {
  it("answers a private repo as private, by GitHub's ID, with the token given", async () => {
    const gh = fakeGitHub([{ ...SHOP, private: true }]);
    const result = await resolveRepoById(42, { fetch: gh.fetch, token: "ghu_user" });
    expect(result).toEqual({
      ok: true,
      repo: {
        providerRepoId: 42,
        owner: "Acme",
        name: "Shop",
        visibility: "private",
        defaultBranch: "trunk",
        sha: SHA,
        sizeKb: 2_048,
      },
    });
    expect(gh.requests.map((r) => [r.url, r.accept, r.authorization])).toEqual([
      ["https://api.github.com/repositories/42", "application/vnd.github+json", "Bearer ghu_user"],
      [
        "https://api.github.com/repositories/42/commits/HEAD",
        "application/vnd.github.sha",
        "Bearer ghu_user",
      ],
    ]);
  });

  it("says when the repo is public now", async () => {
    const gh = fakeGitHub([SHOP]);
    const result = await resolveRepoById(42, { fetch: gh.fetch });
    expect(result.ok && result.repo.visibility).toBe("public");
  });

  it("never matches an answer about another repo", async () => {
    const gh = fakeGitHub([{ ...SHOP, private: true }]);
    gh.failNext(
      Response.json({
        id: 43,
        name: "Other",
        owner: { login: "Acme" },
        private: true,
        default_branch: "main",
      }),
    );
    expect(await resolveRepoById(42, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "GITHUB_UNAVAILABLE",
    });
    expect(gh.requests).toHaveLength(1);
  });

  it("reports GitHub's failures as resolveRepo does", async () => {
    const gh = fakeGitHub([{ ...SHOP, sha: null }]);
    expect(await resolveRepoById(7, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
    expect(await resolveRepoById(42, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_EMPTY",
    });
    gh.failNext(new Error("offline"));
    expect(await resolveRepoById(42, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "GITHUB_UNAVAILABLE",
    });
  });
});

describe("resolveSeenRepo", () => {
  it("answers a private repo as private, by name, with the token given (M8.4c2b)", async () => {
    const gh = fakeGitHub([{ ...SHOP, private: true }]);
    const result = await resolveSeenRepo(
      { owner: "acme", repo: "shop" },
      { fetch: gh.fetch, token: "ghu_user" },
    );
    expect(result).toEqual({
      ok: true,
      repo: {
        providerRepoId: 42,
        owner: "Acme",
        name: "Shop",
        visibility: "private",
        defaultBranch: "trunk",
        sha: SHA,
        sizeKb: 2_048,
      },
    });
    expect(gh.requests.map((r) => [r.url, r.authorization])).toEqual([
      ["https://api.github.com/repos/acme/shop", "Bearer ghu_user"],
      ["https://api.github.com/repos/Acme/Shop/commits/HEAD", "Bearer ghu_user"],
    ]);
  });

  it("answers a public repo as public, and a missing one as resolveRepo does", async () => {
    const gh = fakeGitHub([SHOP]);
    const seen = await resolveSeenRepo({ owner: "acme", repo: "shop" }, { fetch: gh.fetch });
    expect(seen.ok && seen.repo.visibility).toBe("public");
    expect(await resolveSeenRepo({ owner: "acme", repo: "nope" }, { fetch: gh.fetch })).toEqual({
      ok: false,
      code: "REPO_NOT_FOUND",
    });
  });
});

describe("fetchCodeBytes", () => {
  const ask = (gh: FakeGitHub, token?: string) =>
    fetchCodeBytes(
      { owner: "Acme", name: "Shop" },
      { fetch: gh.fetch, ...(token ? { token } : {}) },
    );

  it("sums the TypeScript and JavaScript bytes GitHub counts, nothing else", async () => {
    const gh = fakeGitHub([
      {
        ...SHOP,
        languages: { TypeScript: 1_000, JavaScript: 200, TSX: 30, JSX: 4, CSS: 99_999, Rust: 1 },
      },
    ]);
    expect(await ask(gh, "t0ken")).toBe(1_234);
    expect(gh.requests.map((r) => [r.url, r.accept, r.authorization])).toEqual([
      [
        "https://api.github.com/repos/Acme/Shop/languages",
        "application/vnd.github+json",
        "Bearer t0ken",
      ],
    ]);
    // A repo with none of them (or no code at all) counts zero.
    expect(await ask(fakeGitHub([{ ...SHOP, languages: { Go: 5_000 } }]))).toBe(0);
    expect(await ask(fakeGitHub([{ ...SHOP, languages: {} }]))).toBe(0);
  });

  it("is unknown when GitHub can't be asked or answers something unreadable", async () => {
    const answers: (Response | Error)[] = [
      new TypeError("fetch failed"),
      new Response("", { status: 502 }),
      new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      new Response(null, { status: 301, headers: { location: "https://evil.example/x" } }),
      new Response("{not json"),
      Response.json([1, 2]),
      Response.json({ TypeScript: "lots" }),
      Response.json({ TypeScript: -1 }),
      Response.json({ JavaScript: 1.5 }),
      Response.json({ TypeScript: Number.MAX_SAFE_INTEGER + 1 }),
      new Response(" ".repeat(1024 * 1024 + 1)),
    ];
    for (const answer of answers) {
      const gh = fakeGitHub([SHOP]);
      gh.failNext(answer);
      expect(await ask(gh)).toBeUndefined();
    }
    // A missing repo too.
    expect(await ask(fakeGitHub([]))).toBeUndefined();
  });

  it("follows a rename inside the API", async () => {
    const gh = fakeGitHub([{ ...SHOP, languages: { TypeScript: 7 } }]);
    gh.failNext(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/acme/shop/languages" },
      }),
    );
    expect(await ask(gh)).toBe(7);
  });
});
