import { describe, expect, it, vi } from "vitest";
import shopDemo from "../../../fixtures/shop-demo/expected.json";
import { NBSP } from "./limits";
import {
  headStatus,
  LOAD_FAILED_MESSAGE,
  LOAD_FAILED_TITLE,
  loadGraph,
  short,
  UNREADABLE_MESSAGE,
  UNREADABLE_TITLE,
} from "./repoStatus";
import { OFFLINE_MESSAGE } from "./startAnalysis";

const SHA = "a".repeat(40);
const NEWER = "b1c2d3e".padEnd(40, "0");
const status = (head: Parameters<typeof headStatus>[2]) => headStatus("acme", "shop", head);

describe("headStatus", () => {
  it("calls a permalink what it is and links the latest diagram", () => {
    expect(status({ state: "pinned" })).toEqual({
      tone: "quiet",
      text: "A permalink: this commit's diagram never changes.",
      link: { href: "/acme/shop", label: "See the latest" },
    });
  });

  it("says plainly when the diagram is current", () => {
    expect(status({ state: "current" })).toEqual({
      tone: "quiet",
      text: "Up to date with the latest commit.",
    });
  });

  it("links the progress page of a newer analysis when its job is known", () => {
    const text =
      "The latest commit, b1c2d3e, is being analyzed. This is the previous diagram until it's ready.";
    const job = `analyze-${"c".repeat(32)}`;
    expect(status({ state: "updating", sha: NEWER, jobId: job })).toEqual({
      tone: "updating",
      text,
      link: { href: `/acme/shop/jobs/${job}`, label: "Watch progress" },
    });
    expect(status({ state: "updating", sha: NEWER })).toEqual({ tone: "updating", text });
  });

  it("explains each reason a newer commit isn't shown, offering a retry only after a failure", () => {
    const failed = { state: "behind", sha: NEWER, reason: "failed" } as const;
    expect(status({ ...failed, errorCode: "ANALYZER_CRASHED" })).toEqual({
      tone: "behind",
      text: "The latest commit, b1c2d3e, couldn't be analyzed, so this is an earlier one.",
      analyze: true,
    });
    expect(status({ state: "behind", sha: NEWER, reason: "limited" })).toEqual({
      tone: "behind",
      text: "This repo changed often this hour, so the latest commit, b1c2d3e, will be analyzed on a later visit. This is an earlier one.",
    });
    expect(status({ state: "behind", sha: NEWER, reason: "unavailable" })).toEqual({
      tone: "behind",
      text: "Analysis is temporarily unavailable, so this is an earlier commit than the latest, b1c2d3e.",
    });
  });

  it("gives the reason instead of Analyze again when the failure would happen again (M5 review)", () => {
    const failed = { state: "behind", sha: NEWER, reason: "failed" } as const;
    expect(status({ ...failed, errorCode: "LIMIT_FILES" })).toEqual({
      tone: "behind",
      text: `The latest commit, b1c2d3e, can't be analyzed, so this is an earlier one. This repo has over 20,000 source files. GitInside analyzes repos up to 20,000 source files and 50${NBSP}MB of source code.`,
    });
    expect(status({ ...failed, errorCode: "TAR_UNSAFE_PATH" })).toEqual({
      tone: "behind",
      text: "The latest commit, b1c2d3e, can't be analyzed, so this is an earlier one. GitHub's download of this repo has paths outside the repo, so it wasn't analyzed.",
    });
  });

  it("doesn't claim the diagram is current when GitHub couldn't be asked", () => {
    expect(status({ state: "unknown" })).toEqual({
      tone: "behind",
      text: "We couldn't ask GitHub for newer commits, so this may not be the latest.",
    });
  });

  it("shortens SHAs the way GitHub does", () => {
    expect(short(NEWER)).toBe("b1c2d3e");
  });
});

describe("loadGraph", () => {
  const URL = `/api/graph/acme/shop/${SHA}`;
  const respond = (response: Response | Promise<Response>) =>
    vi.fn<typeof fetch>(() => Promise.resolve(response));

  it("fetches the graph and validates it against the schema", async () => {
    const doFetch = respond(new Response(JSON.stringify(shopDemo)));
    const load = await loadGraph(URL, { fetch: doFetch });
    expect(doFetch).toHaveBeenCalledWith(URL, {});
    expect(load.ok && load.graph.repo.name).toBe("shop-demo");
  });

  it("passes the abort signal on, and rethrows when aborted", async () => {
    const controller = new AbortController();
    const doFetch = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await expect(loadGraph(URL, { fetch: doFetch, signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });

  it("says the network is down when the request can't be sent", async () => {
    const doFetch = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await loadGraph(URL, { fetch: doFetch })).toEqual({
      ok: false,
      title: LOAD_FAILED_TITLE,
      message: OFFLINE_MESSAGE,
      retry: true,
    });
  });

  it("shows the server's own words; a missing graph isn't worth retrying", async () => {
    const body = (message: string) => JSON.stringify({ error: "X", message });
    expect(
      await loadGraph(URL, { fetch: respond(new Response(body("No diagram."), { status: 404 })) }),
    ).toEqual({ ok: false, title: LOAD_FAILED_TITLE, message: "No diagram.", retry: false });
    expect(
      await loadGraph(URL, { fetch: respond(new Response(body("Down."), { status: 503 })) }),
    ).toEqual({ ok: false, title: LOAD_FAILED_TITLE, message: "Down.", retry: true });
  });

  it("falls back to its own words when an error body has none", async () => {
    for (const body of ["<html>", "{}", '{"message":""}', "null"]) {
      expect(await loadGraph(URL, { fetch: respond(new Response(body, { status: 502 })) })).toEqual(
        { ok: false, title: LOAD_FAILED_TITLE, message: LOAD_FAILED_MESSAGE, retry: true },
      );
    }
  });

  it("refuses a body that isn't a valid graph rather than drawing part of it", async () => {
    for (const body of ["{not json", "{}", JSON.stringify({ ...shopDemo, nodes: "x" })]) {
      expect(await loadGraph(URL, { fetch: respond(new Response(body)) })).toEqual({
        ok: false,
        title: UNREADABLE_TITLE,
        message: UNREADABLE_MESSAGE,
        retry: false,
      });
    }
  });

  it("never repeats its heading as the words under it", () => {
    for (const [title, message] of [
      [LOAD_FAILED_TITLE, LOAD_FAILED_MESSAGE],
      [LOAD_FAILED_TITLE, OFFLINE_MESSAGE],
      [UNREADABLE_TITLE, UNREADABLE_MESSAGE],
    ] as const) {
      expect(message.toLowerCase()).not.toContain(title.toLowerCase());
    }
  });

  it("retries when the connection drops while the body arrives", async () => {
    const broken = new Response("{}");
    vi.spyOn(broken, "text").mockRejectedValue(new TypeError("network error"));
    expect(await loadGraph(URL, { fetch: respond(broken) })).toEqual({
      ok: false,
      title: LOAD_FAILED_TITLE,
      message: LOAD_FAILED_MESSAGE,
      retry: true,
    });
    const controller = new AbortController();
    const aborted = new Response("{}");
    vi.spyOn(aborted, "text").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await expect(
      loadGraph(URL, { fetch: respond(aborted), signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});
