// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FAILED_MESSAGE,
  OFFLINE_MESSAGE,
  permalinkHref,
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

  it("a request for the bot check comes back with the widget's site key (ADR-0157)", async () => {
    const message = "GitInside is busier than usual, so we're checking that you're a person.";
    const { doFetch } = answering(
      Response.json({ error: "CHALLENGE_REQUIRED", message, siteKey: "0x4AAA" }, { status: 403 }),
    );
    expect(await startAnalysis("acme/shop", doFetch)).toEqual({
      ok: false,
      message,
      challenge: { siteKey: "0x4AAA" },
    });
    // A failed check only says so: pressing Analyze again asks for a fresh one.
    const failed = answering(
      Response.json({ error: "CHALLENGE_FAILED", message, siteKey: "0x4AAA" }, { status: 403 }),
    );
    expect(await startAnalysis("acme/shop", failed.doFetch)).toEqual({ ok: false, message });
    // Without a site key there's no widget to show.
    const keyless = answering(
      Response.json({ error: "CHALLENGE_REQUIRED", message }, { status: 403 }),
    );
    expect(await startAnalysis("acme/shop", keyless.doFetch)).toEqual({ ok: false, message });
  });

  it("sends the widget's token with the URL once the visitor was asked", async () => {
    const { doFetch, seen } = answering(
      Response.json({ status: "done", owner: "acme", repo: "shop", sha: SHA }),
    );
    await startAnalysis("acme/shop", doFetch, "tok.en");
    expect(await seen[0]?.json()).toEqual({ url: "acme/shop", turnstileToken: "tok.en" });
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
    const sha = "e".repeat(40);
    expect(progressHref("a", "b", JOB, sha)).toBe(`/a/b/jobs/${JOB}?commit=${sha}`);
    expect(progressHref("a", "b", JOB, sha, "sel=x")).toBe(`/a/b/jobs/${JOB}?commit=${sha}&sel=x`);
    // A deep link is kept only for a commit's page.
    expect(progressHref("a", "b", JOB, undefined, "sel=x")).toBe(`/a/b/jobs/${JOB}`);
    expect(permalinkHref("a", "b c", sha)).toBe(`/a/b%20c/${sha}`);
    expect(permalinkHref("a", "b", sha, "sel=x")).toBe(`/a/b/${sha}?sel=x`);
  });
});
