// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as events } from "./events/route";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ID = `analyze-${"a".repeat(32)}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/jobs/:id and /events", () => {
  it("are unavailable until the worker is configured", async () => {
    vi.stubEnv("WORKER_URL", "");
    const response = await GET(new Request(`https://gitinside.test/api/jobs/${ID}`), params(ID));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "unavailable" });

    const abort = new AbortController();
    const stream = await events(
      new Request(`https://gitinside.test/api/jobs/${ID}/events`, { signal: abort.signal }),
      params(ID),
    );
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: status")) {
      text += decoder.decode((await reader.read()).value);
    }
    expect(text).toContain('"state":"unavailable"');
    abort.abort();
  });

  it("answer 404 for IDs the worker never issues", async () => {
    const bad = "analyze-1";
    expect((await GET(new Request("https://gitinside.test/"), params(bad))).status).toBe(404);
    expect((await events(new Request("https://gitinside.test/"), params(bad))).status).toBe(404);
  });
});
