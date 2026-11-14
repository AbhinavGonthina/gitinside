import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countVisit } from "./visit";

const sent: string[] = [];

class FakeImage {
  set src(value: string) {
    sent.push(value);
  }
}

function at(url: string) {
  vi.stubGlobal("location", new URL(url));
}

describe("countVisit", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("Image", FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pings once with only site, path, referrer, and a cache buster on the landing page", () => {
    at("https://gitinside.abhinavgonthina.dev/");
    countVisit();
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!);
    expect(url.origin).toBe("https://visits.agonthina.workers.dev");
    expect([...url.searchParams.keys()].sort()).toEqual(["p", "r", "rnd", "site"]);
    expect(url.searchParams.get("site")).toBe("g");
    expect(url.searchParams.get("p")).toBe("/");
  });

  it("stays silent on preview hosts, localhost, and deep links", () => {
    for (const url of [
      "https://gitinside-git-branch-abhinav.vercel.app/",
      "http://localhost:3000/",
      "https://gitinside.abhinavgonthina.dev/vercel/next.js",
    ]) {
      at(url);
      countVisit();
    }
    expect(sent).toHaveLength(0);
  });

  it("respects Do Not Track", () => {
    at("https://gitinside.vercel.app/");
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    try {
      countVisit();
    } finally {
      delete (navigator as { doNotTrack?: string }).doNotTrack;
    }
    expect(sent).toHaveLength(0);
  });

  it("waits for the load event when the page is still loading", () => {
    at("https://gitinside.vercel.app/");
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    countVisit();
    expect(sent).toHaveLength(0);
    window.dispatchEvent(new Event("load"));
    expect(sent).toHaveLength(1);
  });
});
