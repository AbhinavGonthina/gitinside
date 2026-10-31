import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { failureView, type JobView } from "../../../../../lib/jobs";
import { COPIED_MS, JOB_LINK_COPIED, JOB_LINK_COPY_FAILED, JobProgress } from "./JobProgress";

const push = vi.fn();
const replace = vi.fn();
// One object, like Next.js's own router: the stream's effect depends on it.
const router = { push, replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const JOB = `analyze-${"d".repeat(32)}`;

/** jsdom has no EventSource; this one is driven by the test. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  send(view: JobView | string) {
    act(() => {
      this.dispatchEvent(
        new MessageEvent("status", {
          data: typeof view === "string" ? view : JSON.stringify(view),
        }),
      );
    });
  }
  fail(readyState: number) {
    act(() => {
      this.readyState = readyState;
      this.dispatchEvent(new Event("error"));
    });
  }
}

const latest = () => FakeEventSource.instances.at(-1)!;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  FakeEventSource.instances = [];
  push.mockReset();
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", `/acme/shop/jobs/${JOB}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => render(<JobProgress owner="acme" repo="shop" jobId={JOB} />);

function steps() {
  return screen.getAllByRole("listitem").map((li) => [li.dataset.status, li.textContent]);
}

describe("JobProgress", () => {
  it("listens to the job's event stream and starts at the queue", () => {
    show();
    expect(latest().url).toBe(`/api/jobs/${JOB}/events`);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme / shop");
    expect(steps()[0]).toEqual(["current", "In the queueChecking the queue"]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("shows the queue position (UX.md: '2 ahead of you')", () => {
    show();
    latest().send({ state: "queued", step: "queue", progress: 0, text: "2 ahead of you" });
    expect(steps()[0]).toEqual(["current", "In the queue2 ahead of you"]);
    // The job link's copy status is a second live region; this is the steps' one.
    expect(screen.getAllByRole("status")[0]?.textContent).toBe("2 ahead of you");
  });

  it("marks the stages walked, the current one with the worker's words, the rest ahead", () => {
    show();
    latest().send({ state: "running", step: "analyze", progress: 34, text: "Parsing 1,204 files" });
    expect(steps()).toEqual([
      ["done", "In the queue (done)"],
      ["done", "Downloading (done)"],
      ["done", "Unpacking (done)"],
      ["current", "AnalyzingParsing 1,204 files"],
      ["next", "Saving the diagram"],
    ]);
    const current = screen.getAllByRole("listitem")[3]!;
    expect(current.getAttribute("aria-current")).toBe("step");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("34");
    expect(bar.getAttribute("aria-valuetext")).toBe("Analyzing: Parsing 1,204 files");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("34%");
  });

  it("opens the diagram when it's saved, and stops listening", () => {
    show();
    latest().send({ state: "done" });
    expect(replace).toHaveBeenCalledWith("/acme/shop");
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
  });

  it("a permanent failure says what happened, offers no retry, and takes focus", () => {
    show();
    latest().send(failureView("LIMIT_FILES"));
    expect(screen.getByRole("alert").textContent).toBe(failureView("LIMIT_FILES").message);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    expect(screen.getByRole("link", { name: "Analyze another repo" }).getAttribute("href")).toBe(
      "/",
    );
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/acme/shop",
    );
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
  });

  it("'Try again' re-asks for the repo and restarts the stream for the same job", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { status: "queued", jobId: JOB, owner: "acme", repo: "shop", sha: "c".repeat(40) },
        { status: 202 },
      ),
    );
    show();
    latest().send(failureView("DOWNLOAD_FAILED"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ url: "acme/shop" });
    expect(steps()[0]?.[0]).toBe("current");
    expect(push).not.toHaveBeenCalled();
  });

  it("'Analyze again' for a missing job goes wherever the server says", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ status: "done", owner: "acme", repo: "shop", sha: "c".repeat(40) }),
    );
    show();
    latest().send({ state: "missing", message: "We couldn't find this analysis." });
    fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme/shop"));
  });

  it("a refused retry says why next to the failure", async () => {
    const message = "You've analyzed 5 repos this hour. Try again in 3 minutes.";
    fetchMock.mockResolvedValue(Response.json({ error: "RATE_LIMITED", message }, { status: 429 }));
    show();
    latest().send(failureView("JOB_STALLED"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[1]?.textContent).toBe(message);
  });

  it("keeps the last progress with a notice while the worker is unreachable", () => {
    show();
    latest().send({ state: "running", step: "download", progress: 0, text: "Downloading" });
    latest().send({ state: "unavailable", message: "Analysis is temporarily unavailable." });
    expect(screen.getByRole("alert").textContent).toBe("Analysis is temporarily unavailable.");
    expect(steps()[1]?.[0]).toBe("current");
    latest().send({ state: "running", step: "extract", progress: 10, text: "Unpacking" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a stream the browser gave up on reads as unavailable; a reconnect doesn't", () => {
    show();
    latest().fail(FakeEventSource.CONNECTING);
    expect(screen.queryByRole("alert")).toBeNull();
    latest().fail(FakeEventSource.CLOSED);
    expect(screen.getByRole("alert").textContent).toBe(
      "Analysis is temporarily unavailable. Already-analyzed repos still work.",
    );
  });

  it("ignores events that aren't views", () => {
    show();
    latest().send("not json");
    latest().send(JSON.stringify({ state: "exploded" }));
    latest().send(JSON.stringify(null));
    expect(steps()[0]).toEqual(["current", "In the queueChecking the queue"]);
  });

  it("says the analysis keeps running if you leave, with the job link to reopen (#8)", () => {
    show();
    expect(screen.getByText(/keeps running if you leave/).textContent).toBe(
      "The analysis keeps running if you leave. Reopen this link any time: it shows the progress, or opens the diagram once it's ready.",
    );
    const link = screen.getByRole("textbox", { name: "Job link" }) as HTMLInputElement;
    expect(link.readOnly).toBe(true);
    expect(link.value).toBe(`${window.location.origin}/acme/shop/jobs/${JOB}`);
  });

  it("the job link leaves out the query and hash", () => {
    window.history.replaceState(null, "", `/acme/shop/jobs/${JOB}?utm=x#top`);
    show();
    const link = screen.getByRole("textbox", { name: "Job link" }) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/acme/shop/jobs/${JOB}`);
  });

  it("Copy link copies the job link, says so, and goes back after a moment", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    show();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/acme/shop/jobs/${JOB}`);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText(JOB_LINK_COPIED).getAttribute("role")).toBe("status");
    await act(() => vi.advanceTimersByTimeAsync(COPIED_MS));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(screen.queryByText(JOB_LINK_COPIED)).toBeNull();
  });

  it("a refused copy selects the link and says to copy it by hand", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("no"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    show();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy link" })));
    expect(screen.getByText(JOB_LINK_COPY_FAILED).getAttribute("role")).toBe("status");
    const link = screen.getByRole("textbox", { name: "Job link" }) as HTMLInputElement;
    expect(document.activeElement).toBe(link);
    expect([link.selectionStart, link.selectionEnd]).toEqual([0, link.value.length]);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("keeps the job link on screen while the worker is unreachable", () => {
    show();
    latest().send({ state: "unavailable", message: "Analysis is temporarily unavailable." });
    expect(screen.getByRole("textbox", { name: "Job link" })).toBeTruthy();
  });

  it("drops the job link once the analysis has failed: there's nothing to come back to", () => {
    show();
    latest().send(failureView("LIMIT_FILES"));
    expect(screen.queryByRole("textbox", { name: "Job link" })).toBeNull();
    expect(screen.queryByText(/keeps running/)).toBeNull();
  });

  it("a link reopened after the job is gone offers the repo's diagram (#8)", () => {
    show();
    latest().send({ state: "missing", message: "We couldn't find this analysis." });
    expect(screen.getByRole("link", { name: "Open the diagram" }).getAttribute("href")).toBe(
      "/acme/shop",
    );
  });

  it("a failed analysis doesn't offer a diagram it never made", () => {
    show();
    latest().send(failureView("LIMIT_FILES"));
    expect(screen.queryByRole("link", { name: "Open the diagram" })).toBeNull();
  });

  it("closes the stream when the page goes away", () => {
    const { unmount } = show();
    unmount();
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
  });
});
