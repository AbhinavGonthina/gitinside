// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_CSP } from "../../../../../lib/csp";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const params = (repo: string) => ({ params: Promise.resolve({ owner: "acme", repo }) });

describe("GET /api/badge/:owner/:repo.svg", () => {
  it("is the link-only badge until the database and bucket are configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const response = await GET(new Request("https://gitinside.test/"), params("shop.svg"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(IMAGE_CSP);
    expect(await response.text()).toContain("view architecture");
  });

  it("answers 404 without the .svg", async () => {
    expect((await GET(new Request("https://gitinside.test/"), params("shop"))).status).toBe(404);
  });
});
