import { describe, expect, it } from "vitest";
import { JobFailure } from "./failure.js";
import {
  MAX_REDIRECTS,
  failureForStatus,
  fetchRepoFacts,
  openTarball,
  type DownloadOptions,
} from "./github.js";

const SOURCE = { owner: "acme", repo: "shop", sha: "0123456789abcdef0123456789abcdef01234567" };
const API = "https://api.github.com";
const CODELOAD = "https://codeload.github.com";

/** A fetch that answers from `script` in order and records what it was asked. */
function scripted(...script: Response[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = script.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next;
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const redirect = (status: number, location?: string): Response =>
  new Response(null, { status, headers: location === undefined ? {} : { location } });
const ok = (): Response => new Response("tarball");

async function codeOf(options: DownloadOptions): Promise<string> {
  try {
    await openTarball(SOURCE, options);
  } catch (error) {
    if (error instanceof JobFailure) return error.code;
    throw error;
  }
  return "OK";
}

describe("openTarball", () => {
  it("asks the API for the tarball with GitHub's headers", async () => {
    const { calls, fetch } = scripted(redirect(302, `${CODELOAD}/acme/shop/legacy.tar.gz/x`), ok());
    const body = await openTarball(SOURCE, { fetch, token: "t" });
    expect(await new Response(body).text()).toBe("tarball");
    expect(calls[0]).toEqual({
      url: `${API}/repos/acme/shop/tarball/${SOURCE.sha}`,
      headers: {
        "user-agent": "gitinside-worker",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: "Bearer t",
      },
    });
    expect(calls[1]).toEqual({
      url: `${CODELOAD}/acme/shop/legacy.tar.gz/x`,
      headers: { "user-agent": "gitinside-worker" },
    });
  });

  it("sends no authorization header without a token", async () => {
    const { calls, fetch } = scripted(ok());
    await openTarball(SOURCE, { fetch });
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("keeps a path in the API base (GitHub Enterprise style)", async () => {
    const { calls, fetch } = scripted(ok());
    await openTarball(SOURCE, { fetch, apiBase: "https://ghe.example/api/v3/" });
    expect(calls[0]?.url).toBe(`https://ghe.example/api/v3/repos/acme/shop/tarball/${SOURCE.sha}`);
  });

  it(`follows at most ${MAX_REDIRECTS} redirects inside the API`, async () => {
    const hops = Array.from({ length: MAX_REDIRECTS }, (_, i) =>
      redirect(301, `/repositories/${i}`),
    );
    expect(await codeOf({ fetch: scripted(...hops, ok()).fetch })).toBe("OK");
    const tooMany = Array.from({ length: MAX_REDIRECTS + 1 }, () => redirect(301, "/again"));
    expect(await codeOf({ fetch: scripted(...tooMany).fetch })).toBe("DOWNLOAD_REFUSED");
  });

  it.each([
    ["no location", redirect(302)],
    ["an invalid location", redirect(302, "http://[")],
    ["another host", redirect(302, "https://evil.example/x.tar.gz")],
    ["plain http to codeload", redirect(302, "http://codeload.github.com/x")],
  ])("refuses a redirect with %s", async (_, response) => {
    expect(await codeOf({ fetch: scripted(response).fetch })).toBe("DOWNLOAD_REFUSED");
  });

  it("refuses any redirect from the download host", async () => {
    const { fetch } = scripted(redirect(302, `${CODELOAD}/x`), redirect(302, `${CODELOAD}/y`));
    expect(await codeOf({ fetch })).toBe("DOWNLOAD_REFUSED");
    const back = scripted(redirect(302, `${CODELOAD}/x`), redirect(302, `${API}/repos/x`));
    expect(await codeOf({ fetch: back.fetch })).toBe("DOWNLOAD_REFUSED");
  });

  it("fails a 200 without a body as retriable", async () => {
    const empty = new Response(null, { status: 200 });
    expect(await codeOf({ fetch: scripted(empty).fetch })).toBe("DOWNLOAD_FAILED");
  });

  it("rethrows the signal's reason when it fires", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    const fetch = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as typeof globalThis.fetch;
    await expect(openTarball(SOURCE, { fetch, signal: controller.signal })).rejects.toBe(reason);
  });

  it("encodes the path parts", async () => {
    const { calls, fetch } = scripted(ok());
    await openTarball({ ...SOURCE, repo: "a.b_c-d" }, { fetch });
    expect(calls[0]?.url).toContain("/repos/acme/a.b_c-d/tarball/");
  });
});

describe("failureForStatus", () => {
  it.each([
    [404, {}, "REPO_NOT_FOUND"],
    [451, {}, "REPO_UNAVAILABLE"],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED"],
    [403, { "x-ratelimit-remaining": "12" }, "DOWNLOAD_REFUSED"],
    [429, { "retry-after": "1" }, "GITHUB_RATE_LIMITED"],
    [429, {}, "DOWNLOAD_REFUSED"],
    [401, {}, "DOWNLOAD_REFUSED"],
    [408, {}, "DOWNLOAD_FAILED"],
    [500, {}, "DOWNLOAD_FAILED"],
    [503, {}, "DOWNLOAD_FAILED"],
  ])("%i %j ⇒ %s", (status, headers, code) => {
    expect(failureForStatus(status, new Headers(headers)).code).toBe(code);
  });
});

describe("fetchRepoFacts", () => {
  const REPO_JSON = {
    id: 3_000_000_001,
    name: "Shop",
    owner: { login: "Acme", id: 7 },
    private: false,
    default_branch: "trunk",
    description: "ignored",
  };
  const json = (value: unknown): Response => new Response(JSON.stringify(value));

  async function factsCode(options: DownloadOptions): Promise<string> {
    try {
      await fetchRepoFacts(SOURCE, options);
    } catch (error) {
      if (error instanceof JobFailure) return error.code;
      throw error;
    }
    return "OK";
  }

  it("asks the API with GitHub's headers and keeps GitHub's spelling", async () => {
    const { calls, fetch } = scripted(json(REPO_JSON));
    expect(await fetchRepoFacts(SOURCE, { fetch, token: "t" })).toEqual({
      id: 3_000_000_001,
      owner: "Acme",
      name: "Shop",
      private: false,
      defaultBranch: "trunk",
    });
    expect(calls).toEqual([
      {
        url: `${API}/repos/acme/shop`,
        headers: {
          "user-agent": "gitinside-worker",
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: "Bearer t",
        },
      },
    ]);
  });

  it("follows a renamed repo's redirect inside the API, with the token", async () => {
    const { calls, fetch } = scripted(
      redirect(301, `${API}/repositories/3000000001`),
      json(REPO_JSON),
    );
    expect((await fetchRepoFacts(SOURCE, { fetch, token: "t" })).name).toBe("Shop");
    expect(calls.map((c) => [c.url, c.headers.authorization])).toEqual([
      [`${API}/repos/acme/shop`, "Bearer t"],
      [`${API}/repositories/3000000001`, "Bearer t"],
    ]);
  });

  it.each([
    ["another host", [redirect(302, "https://evil.example/repos/acme/shop")]],
    ["no location", [redirect(302)]],
    ["a bad location", [redirect(302, "http://[")]],
    [
      "too many hops",
      Array.from({ length: MAX_REDIRECTS + 1 }, () => redirect(301, `${API}/repositories/1`)),
    ],
  ])("refuses a redirect to %s", async (_, script) => {
    const { calls, fetch } = scripted(...script);
    expect(await factsCode({ fetch })).toBe("DOWNLOAD_REFUSED");
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no owner", JSON.stringify({ ...REPO_JSON, owner: null })],
    ["a bad owner", JSON.stringify({ ...REPO_JSON, owner: { login: "-x" } })],
    ["a bad name", JSON.stringify({ ...REPO_JSON, name: "a/b" })],
    ["a bad ID", JSON.stringify({ ...REPO_JSON, id: 1.5 })],
    ["no visibility", JSON.stringify({ ...REPO_JSON, private: "no" })],
    ["no default branch", JSON.stringify({ ...REPO_JSON, default_branch: "" })],
    ["a huge body", JSON.stringify({ ...REPO_JSON, description: "x".repeat(1024 * 1024) })],
  ])("refuses an answer with %s", async (_, text) => {
    const { fetch } = scripted(new Response(text));
    expect(await factsCode({ fetch })).toBe("DOWNLOAD_REFUSED");
  });

  it.each([
    [404, "REPO_NOT_FOUND"],
    [403, "GITHUB_RATE_LIMITED"],
    [502, "DOWNLOAD_FAILED"],
  ])("maps %i to %s", async (status, code) => {
    const headers = status === 403 ? { "x-ratelimit-remaining": "0" } : {};
    const { fetch } = scripted(new Response("{}", { status, headers }));
    expect(await factsCode({ fetch })).toBe(code);
  });

  it("fails a network error as retriable, and rethrows an abort", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    expect(await factsCode({ fetch: down })).toBe("DOWNLOAD_FAILED");

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      fetchRepoFacts(SOURCE, { fetch: down, signal: controller.signal }),
    ).rejects.toThrow("stop");
  });

  it("fails a body cut off mid-stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: (c) => c.error(new Error("reset")),
    });
    const { fetch } = scripted(new Response(body));
    expect(await factsCode({ fetch })).toBe("DOWNLOAD_FAILED");
  });
});
