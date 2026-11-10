// @vitest-environment node
import { ANALYZER_VERSION } from "@gitinside/analyzer/version";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_MAX_DURATION_SECONDS, handleGraphRequest } from "../../../../../../lib/graphRoute";
import { GET, maxDuration } from "./route";

// The real handler, watched, so a test can see which version the route hands it.
vi.mock("../../../../../../lib/graphRoute", async (original) => {
  const actual = await original<typeof import("../../../../../../lib/graphRoute")>();
  return { ...actual, handleGraphRequest: vi.fn(actual.handleGraphRequest) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(handleGraphRequest).mockClear();
});

const params = (sha: string) => ({
  params: Promise.resolve({ owner: "acme", repo: "shop", sha }),
});

describe("GET /api/graph/:owner/:repo/:sha", () => {
  it("is unavailable until the database and bucket are configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const response = await GET(new Request("https://gitinside.test/"), params("a".repeat(40)));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "UNAVAILABLE" });
    expect(vi.mocked(handleGraphRequest).mock.calls[0]?.[0]).not.toHaveProperty("version");
  });

  it("redirects a made-up query to the canonical URL before any lookup (M5 review)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unreachable.invalid/db");
    const sha = "a".repeat(40);
    const url = `https://gitinside.test/api/graph/acme/shop/${sha}?n=1`;
    const response = await GET(new Request(url), params(sha));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/graph/acme/shop/${sha}`);
  });

  it("hands this analyzer's version to the handler and redirects any other (ADR-0258)", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const sha = "a".repeat(40);
    const path = `/api/graph/acme/shop/${sha}`;
    const current = await GET(
      new Request(`https://gitinside.test${path}?v=${ANALYZER_VERSION}`),
      params(sha),
    );
    expect(current.status).toBe(503); // past the canonical check, to the (unconfigured) handler
    expect(vi.mocked(handleGraphRequest).mock.calls[0]?.[0]).toEqual({
      owner: "acme",
      repo: "shop",
      sha,
      version: ANALYZER_VERSION,
    });
    const older = await GET(new Request(`https://gitinside.test${path}?v=0.0.1`), params(sha));
    expect(older.status).toBe(308);
    expect(older.headers.get("location")).toBe(path);
    expect(handleGraphRequest).toHaveBeenCalledTimes(1);
  });

  it("ends within the bound the hide's second purge waits out (F14, ADR-0238)", () => {
    expect(maxDuration).toBeGreaterThan(0);
    expect(maxDuration).toBe(GRAPH_MAX_DURATION_SECONDS);
  });

  it("answers 404 for a commit that isn't a full SHA", async () => {
    expect((await GET(new Request("https://gitinside.test/"), params("main"))).status).toBe(404);
  });
});
