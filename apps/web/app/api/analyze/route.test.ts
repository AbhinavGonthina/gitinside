// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/analyze", () => {
  it("is temporarily unavailable until the server is configured", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const response = await POST(
      new Request("https://gitinside.test/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"url":"acme/shop"}',
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "UNAVAILABLE" });
  });
});
