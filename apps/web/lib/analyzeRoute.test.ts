// @vitest-environment node
import { createTestDb } from "@gitinside/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeDeps } from "./analyze";
import { MAX_BODY_BYTES, handleAnalyzeRequest } from "./analyzeRoute";
import { fakeGitHub } from "./github.testkit";

const SHA = "f".repeat(40);

/** Deps whose database must never be reached: the requests below stop before it. */
function depsWithoutDb(worker?: AnalyzeDeps["worker"]): AnalyzeDeps {
  const gh = fakeGitHub([{ id: 1, owner: "acme", name: "shop", sha: SHA }]);
  return {
    db: new Proxy({} as AnalyzeDeps["db"], {
      get() {
        throw new Error("database unreachable");
      },
    }),
    worker: worker ?? { enqueue: async () => ({ id: `analyze-${"0".repeat(32)}`, created: true }) },
    github: { fetch: gh.fetch },
    analyzerVersion: "0.1.0",
    rateLimitSecret: "r".repeat(43),
    hourlyLimit: 5,
  };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://gitinside.test/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Answer `request`; with no `deps` argument, {@link depsWithoutDb} (an explicit `undefined` is unconfigured). */
async function answer(request: Request, ...deps: [AnalyzeDeps | undefined] | []) {
  const response = await handleAnalyzeRequest(
    request,
    deps.length === 0 ? depsWithoutDb() : deps[0],
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleAnalyzeRequest", () => {
  it("accepts JSON only", async () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "",
    ]) {
      const result = await answer(post('{"url":"acme/shop"}', { "content-type": type }));
      expect(result.status, type).toBe(415);
      expect(result.body.error).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    const charset = await answer(
      post('{"url":"x"}', { "content-type": "application/json; charset=utf-8" }),
    );
    expect(charset.status).toBe(400);
  });

  it("refuses bodies over the cap, declared or streamed", async () => {
    const big = JSON.stringify({ url: "a".repeat(MAX_BODY_BYTES) });
    expect((await answer(post(big))).status).toBe(413);
    const chunks = [new TextEncoder().encode('{"url":"'), new Uint8Array(MAX_BODY_BYTES).fill(97)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const streamed = await answer(post(stream));
    expect(streamed.status).toBe(413);
    expect(streamed.body.error).toBe("BODY_TOO_LARGE");
  });

  it("accepts a body sent in several chunks", async () => {
    const parts = ['{"url":', '"acme/', 'shop"}'].map((s) => new TextEncoder().encode(s));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    // It reaches the database step, which this test's deps refuse: 500, logged by name.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await answer(post(stream));
    expect(result.status).toBe(500);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "analyze_failed", error: "Error" }));
  });

  it("refuses bodies that aren't { url: string }", async () => {
    const cases: [BodyInit | null, string][] = [
      [null, "INVALID_JSON"],
      ["{", "INVALID_JSON"],
      [new Uint8Array([0x7b, 0xff, 0x7d]), "INVALID_JSON"],
      ["[]", "INVALID_REQUEST"],
      ["null", "INVALID_REQUEST"],
      ['"acme/shop"', "INVALID_REQUEST"],
      ["{}", "INVALID_REQUEST"],
      ['{"url":1}', "INVALID_REQUEST"],
      ['{"url":"acme/shop","sha":"x"}', "INVALID_REQUEST"],
    ];
    for (const [body, error] of cases) {
      const result = await answer(post(body));
      expect([result.status, result.body.error], String(body)).toEqual([400, error]);
    }
  });

  it("refuses very long pasted text without parsing it", async () => {
    const result = await answer(
      post(JSON.stringify({ url: `github.com/acme/${"a".repeat(2_100)}` })),
    );
    expect(result).toMatchObject({ status: 400, body: { error: "INVALID_URL" } });
  });

  it("an unconfigured server is temporarily unavailable", async () => {
    const result = await answer(post('{"url":"acme/shop"}'), undefined);
    expect(result).toEqual(
      expect.objectContaining({
        status: 503,
        body: {
          error: "UNAVAILABLE",
          message: "Analysis is temporarily unavailable. Already-analyzed repos still work.",
        },
      }),
    );
  });

  it("answers with the analysis outcome, never cached", async () => {
    const result = await answer(post('{"url":"not a url"}'));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("INVALID_URL");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("counts against the caller's address and sends Retry-After when limited", async () => {
    const t = await createTestDb();
    try {
      const deps = { ...depsWithoutDb(), db: t.db, hourlyLimit: 1 };
      const from = (ip: string) => post('{"url":"acme/shop"}', { "x-real-ip": ip });
      expect((await answer(from("203.0.113.7"), deps)).status).toBe(202);
      // The first job was recorded as in flight; a new commit needs a new slot.
      deps.github = {
        fetch: fakeGitHub([{ id: 1, owner: "acme", name: "shop", sha: "1".repeat(40) }]).fetch,
      };
      const limited = await answer(from("203.0.113.7"), deps);
      expect(limited).toMatchObject({ status: 429, body: { error: "RATE_LIMITED" } });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await answer(from("203.0.113.8"), deps)).status).toBe(202);
    } finally {
      await t.close();
    }
  });
});
