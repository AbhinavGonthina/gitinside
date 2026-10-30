// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const params = (repo: string) => ({ params: Promise.resolve({ owner: "acme", repo }) });

describe("GET /api/diagram/:owner/:repo.svg", () => {
  it("is the link-only badge until the database is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const url = "https://gitinside.test/api/diagram/acme/shop.svg?theme=dark";
    const response = await GET(new Request(url), params("shop.svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("view architecture");
  });

  it("redirects a made-up query to the canonical URL, keeping the theme (M5 review)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unreachable.invalid/db");
    const url = "https://gitinside.test/api/diagram/acme/shop.svg?theme=dark&n=1";
    const response = await GET(new Request(url), params("shop.svg"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/api/diagram/acme/shop.svg?theme=dark");
  });

  it("answers 404 without the .svg", async () => {
    expect((await GET(new Request("https://gitinside.test/"), params("shop"))).status).toBe(404);
  });
});
