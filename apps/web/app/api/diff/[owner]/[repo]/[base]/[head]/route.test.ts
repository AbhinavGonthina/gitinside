// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const params = (base = BASE, head = HEAD) => ({
  params: Promise.resolve({ owner: "acme", repo: "shop", base, head }),
});

describe("GET /api/diff/:owner/:repo/:base/:head", () => {
  it("is unavailable until the database and bucket are configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const response = await GET(new Request("https://gitinside.test/"), params());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "UNAVAILABLE" });
  });

  it("redirects a made-up query to the canonical URL before any lookup", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unreachable.invalid/db");
    const url = `https://gitinside.test/api/diff/acme/shop/${BASE}/${HEAD}?n=1`;
    const response = await GET(new Request(url), params());
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/diff/acme/shop/${BASE}/${HEAD}`);
  });

  it("answers 404 for commits that aren't full SHAs", async () => {
    const request = new Request("https://gitinside.test/");
    expect((await GET(request, params("main"))).status).toBe(404);
    expect((await GET(request, params(BASE, "abc"))).status).toBe(404);
  });
});
