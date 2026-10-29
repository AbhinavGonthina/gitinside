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

  it("answers 404 for a commit that isn't a full SHA", async () => {
    expect((await GET(new Request("https://gitinside.test/"), params("main"))).status).toBe(404);
  });
});
