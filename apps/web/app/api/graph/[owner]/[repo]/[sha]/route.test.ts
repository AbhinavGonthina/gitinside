// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
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
  });

  it("redirects a made-up query to the canonical URL before any lookup (M5 review)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unreachable.invalid/db");
    const sha = "a".repeat(40);
    const url = `https://gitinside.test/api/graph/acme/shop/${sha}?n=1`;
    const response = await GET(new Request(url), params(sha));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/graph/acme/shop/${sha}`);
  });

  it("answers 404 for a commit that isn't a full SHA", async () => {
    expect((await GET(new Request("https://gitinside.test/"), params("main"))).status).toBe(404);
  });
});
