// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FAILED_MESSAGE,
  OFFLINE_MESSAGE,
  progressHref,
  repoHref,
  startAnalysis,
} from "./startAnalysis";

const JOB = `analyze-${"b".repeat(32)}`;
const SHA = "c".repeat(40);

/** A fetch that answers once with `response`, recording the request. */
function answering(response: Response | Error) {
  const seen: Request[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    seen.push(new Request(new URL(String(input), "https://gitinside.test"), init));
    if (response instanceof Error) throw response;
    return response;
  };
  return { doFetch, seen };
}

describe("startAnalysis", () => {
  it("posts the pasted text as JSON to /api/analyze", async () => {
    const { doFetch, seen } = answering(
      Response.json({ status: "done", owner: "acme", repo: "shop", sha: SHA }),
    );
    expect(await startAnalysis("acme/shop", doFetch)).toEqual({ ok: true, href: "/acme/shop" });
    expect(seen[0]?.method).toBe("POST");
    expect(new URL(seen[0]!.url).pathname).toBe("/api/analyze");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(await seen[0]?.json()).toEqual({ url: "acme/shop" });
  });

  it("a queued commit opens its progress page, in GitHub's spelling", async () => {
    const body = { status: "queued", jobId: JOB, owner: "Acme", repo: "shop.js", sha: SHA };
    const { doFetch } = answering(Response.json(body, { status: 202 }));
    expect(await startAnalysis("acme/shop.js", doFetch)).toEqual({
      ok: true,
      href: `/Acme/shop.js/jobs/${JOB}`,
    });
  });

  it("a refusal comes back with the server's message", async () => {
    const message = "You've analyzed 5 repos this hour. Try again in 12 minutes.";
    const { doFetch } = answering(
      Response.json({ error: "RATE_LIMITED", message }, { status: 429 }),
    );
    expect(await startAnalysis("acme/shop", doFetch)).toEqual({ ok: false, message });
  });

  it("no connection, non-JSON, and odd answers have fixed words", async () => {
    expect(await startAnalysis("a/b", answering(new TypeError("offline")).doFetch)).toEqual({
      ok: false,
      message: OFFLINE_MESSAGE,
    });
    for (const response of [
      new Response("<html>", { status: 502 }),
      Response.json(null),
      Response.json({ status: "queued", jobId: "../../x", owner: "a", repo: "b" }, { status: 202 }),
      Response.json({ status: "done", owner: "", repo: "b" }),
      Response.json({ error: "X", message: "" }, { status: 500 }),
      // A 200 can't smuggle a message in.
      Response.json({ message: "Click here" }),
    ]) {
      expect(await startAnalysis("a/b", answering(response).doFetch)).toEqual({
        ok: false,
        message: FAILED_MESSAGE,
      });
    }
  });

  it("paths encode the names", () => {
    expect(repoHref("a", "b c")).toBe("/a/b%20c");
    expect(progressHref("a", "b", JOB)).toBe(`/a/b/jobs/${JOB}`);
  });
});
