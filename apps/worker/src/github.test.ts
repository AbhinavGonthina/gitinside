import { describe, expect, it } from "vitest";
import { JobFailure } from "./failure.js";
import { MAX_REDIRECTS, failureForStatus, openTarball, type DownloadOptions } from "./github.js";

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
