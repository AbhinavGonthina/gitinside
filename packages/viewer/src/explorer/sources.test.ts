// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createGitHubSourceLoader, createSourceAccess, MAX_SOURCE_BYTES } from "./sources.js";

describe("createSourceAccess", () => {
  it("knows the host's files by own key only", () => {
    const access = createSourceAccess({ "a.ts": "x" }, undefined);
    expect(access.known("a.ts")).toBe("x");
    expect(access.known("constructor")).toBeUndefined();
    expect(access.known("b.ts")).toBeUndefined();
    expect(access.canLoad).toBe(false);
  });

  it("loads each path once and then knows it", async () => {
    const loader = vi.fn(async (path: string) => `text of ${path}`);
    const access = createSourceAccess(undefined, loader);
    const [a, b] = await Promise.all([access.load("a.ts"), access.load("a.ts")]);
    expect(a).toBe("text of a.ts");
    expect(b).toBe("text of a.ts");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(access.known("a.ts")).toBe("text of a.ts");
  });

  it("forgets a failed load, so the next selection tries again", async () => {
    const loader = vi
      .fn<(path: string) => Promise<string | undefined>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("ok");
    const access = createSourceAccess(undefined, loader);
    expect(await access.load("a.ts")).toBeUndefined();
    expect(await access.load("a.ts")).toBeUndefined();
    expect(await access.load("a.ts")).toBe("ok");
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("prefers the host's text over loading", async () => {
    const loader = vi.fn(async () => "loaded");
    const access = createSourceAccess({ "a.ts": "given" }, loader);
    expect(await access.load("a.ts")).toBe("given");
    expect(loader).not.toHaveBeenCalled();
  });
});

function response(body: string | Uint8Array, init: ResponseInit = {}) {
  return new Response(body, { status: 200, ...init });
}

describe("createGitHubSourceLoader", () => {
  const repo = { owner: "acme co", name: "shop", sha: "abc123" };

  it("reads the file at the analyzed commit from GitHub's raw host, without cookies or redirects", async () => {
    const fetch = vi.fn(async () => response("export const x = 1;\n"));
    const load = createGitHubSourceLoader(repo, { fetch });
    expect(await load("src/a b/#x.ts")).toBe("export const x = 1;\n");
    expect(fetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme%20co/shop/abc123/src/a%20b/%23x.ts",
      { credentials: "omit", redirect: "error" },
    );
  });

  it("loads nothing without a commit SHA (a branch may have moved)", async () => {
    const fetch = vi.fn(async () => response("x"));
    const load = createGitHubSourceLoader({ owner: "acme", name: "shop" }, { fetch });
    expect(await load("a.ts")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives up on any answer but 200", async () => {
    for (const status of [404, 403, 500]) {
      const load = createGitHubSourceLoader(repo, {
        fetch: async () => response("nope", { status }),
      });
      expect(await load("a.ts")).toBeUndefined();
    }
  });

  it("refuses files over the cap, by header or by actual size", async () => {
    expect(MAX_SOURCE_BYTES).toBe(2 * 1024 * 1024);
    const declared = createGitHubSourceLoader(repo, {
      maxBytes: 4,
      fetch: async () => response("ab", { headers: { "content-length": "5" } }),
    });
    expect(await declared("a.ts")).toBeUndefined();
    const actual = createGitHubSourceLoader(repo, {
      maxBytes: 4,
      fetch: async () => response("abcde"),
    });
    expect(await actual("a.ts")).toBeUndefined();
    const fits = createGitHubSourceLoader(repo, {
      maxBytes: 4,
      fetch: async () => response("abcd"),
    });
    expect(await fits("a.ts")).toBe("abcd");
  });

  it("refuses a path with a dot, dot-dot, or empty segment without fetching (it could read another repo)", async () => {
    const fetch = vi.fn(async () => response("x"));
    const load = createGitHubSourceLoader(repo, { fetch });
    for (const path of [
      "../../other/repo/a.ts",
      "src/../a.ts",
      "./a.ts",
      "src//a.ts",
      "/a.ts",
      "",
    ]) {
      expect(await load(path)).toBeUndefined();
    }
    for (const bad of [{ owner: ".." }, { name: "." }, { sha: ".." }]) {
      expect(
        await createGitHubSourceLoader({ ...repo, ...bad }, { fetch })("a.ts"),
      ).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops reading a body without a length once it passes the cap", async () => {
    let pulls = 0;
    let cancelled = false;
    // An endless chunked body: only stopping early lets this test finish.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(3).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    });
    const load = createGitHubSourceLoader(repo, {
      maxBytes: 4,
      fetch: async () => new Response(body, { status: 200 }),
    });
    expect(await load("a.ts")).toBeUndefined();
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it("joins a chunked body that fits the cap", async () => {
    const chunks = ["ab", "c", "d"].map((s) => new TextEncoder().encode(s));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const load = createGitHubSourceLoader(repo, {
      maxBytes: 4,
      fetch: async () => new Response(body, { status: 200 }),
    });
    expect(await load("a.ts")).toBe("abcd");
  });

  it("decodes a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const chunks = [bytes.slice(0, 1), bytes.slice(1)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const load = createGitHubSourceLoader(repo, {
      fetch: async () => new Response(body, { status: 200 }),
    });
    expect(await load("a.ts")).toBe("é");
  });

  it("refuses binary files", async () => {
    const load = createGitHubSourceLoader(repo, {
      fetch: async () => response(new Uint8Array([0x61, 0x00, 0x62])),
    });
    expect(await load("a.png")).toBeUndefined();
  });
});
