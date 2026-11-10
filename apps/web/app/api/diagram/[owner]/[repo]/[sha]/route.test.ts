// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const SHA = "a".repeat(40);
const params = (sha: string) => ({ params: Promise.resolve({ owner: "acme", repo: "shop", sha }) });

describe("GET /api/diagram/:owner/:repo/:sha.svg", () => {
  it("is the link-only badge until the database is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const url = `https://gitinside.test/api/diagram/acme/shop/${SHA}.svg?theme=light`;
    const response = await GET(new Request(url), params(`${SHA}.svg`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("view architecture");
  });

  it("redirects a made-up query to the canonical URL, keeping the theme (M5 review)", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://unreachable.invalid/db");
    const url = `https://gitinside.test/api/diagram/acme/shop/${SHA}.svg?n=1&theme=light`;
    const response = await GET(new Request(url), params(`${SHA}.svg`));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`/api/diagram/acme/shop/${SHA}.svg?theme=light`);
  });

  it("answers 404 without the .svg", async () => {
    const response = await GET(new Request("https://gitinside.test/"), params(SHA));
    expect(response.status).toBe(404);
  });
});
