import { describe, it } from "node:test";

describe("notes", () => {
  it("answers", async () => {
    const origin = "http://localhost:4100";
    async function get(path: string) {
      return fetch(origin + path);
    }
    const send = (path: string, method: string) => fetch(`${origin}${path}`, { method });
    await get("/api/status");
    await send("/api/notes", "POST");
  });
});
