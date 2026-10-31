import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shopDemo from "../../../../../fixtures/shop-demo/expected.json";
import { UNAVAILABLE_MESSAGE } from "../../../lib/messages";
import { readmeMarkdown } from "../../../lib/readme";
import {
  LOAD_FAILED_MESSAGE,
  LOAD_FAILED_TITLE,
  UNREADABLE_MESSAGE,
  UNREADABLE_TITLE,
} from "../../../lib/repoStatus";
import { viewRepo, type RepoView, type RepoViewDeps } from "../../../lib/repoView";
import { repoViewDepsFromEnv } from "../../../lib/serverDeps";
import CommitPage, { generateMetadata as commitMetadata } from "./[sha]/page";
import { AddToReadme, COPIED_MESSAGE, COPIED_MS, COPY_FAILED_MESSAGE } from "./AddToReadme";
import { NotAnalyzed } from "./NotAnalyzed";
import RepoPage from "./page";
import { RepoDiagram } from "./RepoDiagram";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../../lib/serverDeps", () => ({ repoViewDepsFromEnv: vi.fn() }));
vi.mock("../../../lib/repoView", async (original) => ({
  ...(await original<typeof import("../../../lib/repoView")>()),
  viewRepo: vi.fn(),
}));

const SHA = "a".repeat(40);
const NEWER = "b".repeat(40);
const GRAPH_URL = `/api/graph/acme/shop/${SHA}`;
const JOB = `analyze-${"c".repeat(32)}`;
const deps = {} as RepoViewDeps;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.mocked(repoViewDepsFromEnv).mockReturnValue(deps);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  window.history.replaceState({}, "", "/acme/shop");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(viewRepo).mockReset();
  vi.restoreAllMocks();
  router.push.mockReset();
  router.refresh.mockReset();
});

const params = (owner: string, repo: string) => Promise.resolve({ owner, repo });
const commitParams = (owner: string, repo: string, sha: string) =>
  Promise.resolve({ owner, repo, sha });

const graphResponse = () => Promise.resolve(new Response(JSON.stringify(shopDemo)));
const analyzeResponse = (status: number, body: object) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function ready(head: Extract<RepoView, { status: "ready" }>["head"]): RepoView {
  return {
    status: "ready",
    owner: "acme",
    repo: "shop",
    sha: SHA,
    analyzerVersion: "0.1.0",
    graphUrl: GRAPH_URL,
    head,
  };
}

describe("repo page", () => {
  it("says analysis is unavailable when the server isn't configured, without a lookup", async () => {
    vi.mocked(repoViewDepsFromEnv).mockReturnValue(undefined);
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(viewRepo).not.toHaveBeenCalled();
  });

  it("says the same when the lookup fails, logging the error's name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(viewRepo).mockRejectedValue(new Error("postgres://user:secret@host failed"));
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "repo_view_failed", error: "Error" }));
    vi.mocked(viewRepo).mockRejectedValue("odd");
    cleanup();
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(log).toHaveBeenLastCalledWith(
      JSON.stringify({ event: "repo_view_failed", error: "unknown" }),
    );
  });

  it("is a 404 for a repo GitHub doesn't show publicly", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "missing" });
    await expect(RepoPage({ params: params("acme", "shop") })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("offers Analyze for a repo nobody has analyzed, in GitHub's spelling", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "not-analyzed", owner: "Acme", repo: "Shop" });
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(viewRepo).toHaveBeenCalledWith({ owner: "acme", repo: "shop" }, deps);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme / Shop");
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });

  it("draws the diagram of a ready repo", async () => {
    fetchMock.mockImplementation(graphResponse);
    vi.mocked(viewRepo).mockResolvedValue(ready({ state: "current" }));
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(GRAPH_URL, expect.anything());
  });
});

describe("commit permalink page", () => {
  it("looks up exactly that commit", async () => {
    vi.mocked(viewRepo).mockResolvedValue(ready({ state: "pinned" }));
    fetchMock.mockImplementation(graphResponse);
    render(await CommitPage({ params: commitParams("acme", "shop", SHA) }));
    expect(viewRepo).toHaveBeenCalledWith({ owner: "acme", repo: "shop", sha: SHA }, deps);
    expect(screen.getByText("A permalink: this commit's diagram never changes.")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
  });

  it.each([
    ["acme", "shop", "main"],
    ["acme", "shop", "aaaaaaa"],
    ["acme", "shop", "A".repeat(40)],
    ["settings", "profile", SHA],
  ])("is a 404 for %j / %j / %j, before any lookup", async (owner, repo, sha) => {
    await expect(CommitPage({ params: commitParams(owner, repo, sha) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(viewRepo).not.toHaveBeenCalled();
  });

  it("is a 404 for a commit nobody analyzed", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "missing" });
    await expect(CommitPage({ params: commitParams("acme", "shop", SHA) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("titles the tab with the short commit, and adds nothing for a bad path", async () => {
    expect(await commitMetadata({ params: commitParams("acme", "shop", SHA) })).toEqual({
      title: "acme/shop at aaaaaaa",
    });
    expect(await commitMetadata({ params: commitParams("acme", "shop", "main") })).toEqual({});
  });
});

describe("RepoDiagram", () => {
  const renderDiagram = (head: Parameters<typeof RepoDiagram>[0]["head"]) =>
    render(<RepoDiagram owner="acme" repo="shop" sha={SHA} graphUrl={GRAPH_URL} head={head} />);

  it("says it's loading, then draws the graph without the explorer's own top bar", async () => {
    fetchMock.mockImplementation(graphResponse);
    const { container } = renderDiagram({ state: "current" });
    expect(screen.getByRole("status").textContent).toBe("Loading the diagram");
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(screen.queryByText("Loading the diagram")).toBeNull();
    expect(container.querySelector(".gi-topbar")).toBeNull();
    const inspector = within(screen.getByRole("complementary"));
    expect(inspector.getByRole("heading", { level: 2 }).textContent).toBe("shop-demo");
  });

  it("shows the first-visit hints until this browser turns them off (M4b.12a)", async () => {
    localStorage.clear();
    fetchMock.mockImplementation(graphResponse);
    renderDiagram({ state: "current" });
    const hint = await screen.findByRole("region", { name: "Zoom in" }, { timeout: 25_000 });
    expect(hint.textContent).toContain("Tip 1 of 3");
    fireEvent.click(within(hint).getByRole("button", { name: "Don't show again" }));
    expect(localStorage.getItem("gitinside.onboarding")).toBe("done");
    cleanup();
    renderDiagram({ state: "current" });
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Zoom in" })).toBeNull();
    localStorage.clear();
  }, 40_000);

  it("shows the repo, its commit on GitHub, and how it relates to the latest", async () => {
    fetchMock.mockImplementation(graphResponse);
    renderDiagram({ state: "updating", sha: NEWER, jobId: JOB });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme / shop");
    const commit = screen.getByTitle(`Commit ${SHA} on GitHub`);
    expect(commit.getAttribute("href")).toBe(`https://github.com/acme/shop/tree/${SHA}`);
    expect(commit.textContent).toBe("aaaaaaa");
    expect(screen.getByText(/The latest commit, bbbbbbb, is being analyzed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch progress" }).getAttribute("href")).toBe(
      `/acme/shop/jobs/${JOB}`,
    );
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/acme/shop",
    );
    expect(screen.queryByRole("button", { name: "Analyze again" })).toBeNull();
    await screen.findByRole("region", { name: "Diagram" });
  });

  it("offers Analyze again after the latest commit failed, and says a refusal in place", async () => {
    fetchMock.mockImplementation((url) =>
      url === "/api/analyze"
        ? analyzeResponse(429, { error: "RATE_LIMITED", message: "You've analyzed 5 repos." })
        : graphResponse(),
    );
    renderDiagram({ state: "behind", sha: NEWER, reason: "failed", errorCode: "DOWNLOAD_FAILED" });
    await screen.findByRole("region", { name: "Diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You've analyzed 5 repos.");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says why, without Analyze again, when the latest commit would fail again (M5 review)", async () => {
    fetchMock.mockImplementation(graphResponse);
    renderDiagram({ state: "behind", sha: NEWER, reason: "failed", errorCode: "LIMIT_TIME" });
    await screen.findByRole("region", { name: "Diagram" });
    expect(screen.getByText(/took over 5 minutes, the limit for one repo\.$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analyze again" })).toBeNull();
  });

  it("goes to the progress page of a started re-analysis", async () => {
    fetchMock.mockImplementation((url) =>
      url === "/api/analyze"
        ? analyzeResponse(202, { status: "queued", jobId: JOB, owner: "acme", repo: "shop" })
        : graphResponse(),
    );
    renderDiagram({ state: "behind", sha: NEWER, reason: "failed", errorCode: "DOWNLOAD_FAILED" });
    fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
  });

  it("puts a failure on the empty-state card, focused, with Try again when it could help", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Temporarily unavailable." }), { status: 503 }),
    );
    renderDiagram({ state: "current" });
    const card = await screen.findByRole("alert");
    expect(card.classList.contains("gi-empty")).toBe(true);
    expect(card.getAttribute("data-tone")).toBe("error");
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe(LOAD_FAILED_TITLE);
    expect(within(card).getByText("Temporarily unavailable.")).toBeTruthy();
    // Focus moves in an effect, which may run just after the card first appears.
    await waitFor(() => expect(document.activeElement).toBe(card));
    // Failing again brings focus to the new card, with the new words.
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    const again = await screen.findByRole("alert");
    expect(within(again).getByText(LOAD_FAILED_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(again));
    fetchMock.mockImplementation(graphResponse);
    fireEvent.click(within(again).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a graph that fails the schema, without offering a pointless retry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nodes: [] })));
    renderDiagram({ state: "current" });
    const card = await screen.findByRole("alert");
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe(UNREADABLE_TITLE);
    expect(within(card).getByText(UNREADABLE_MESSAGE)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Diagram" })).toBeNull();
  });

  it("opens from the page's link and keeps the link in step, without new history entries", async () => {
    fetchMock.mockImplementation(graphResponse);
    const link = "?open=service:api/&sel=route:api/POST%20/api/orders";
    window.history.replaceState({}, "", `/acme/shop${link}#top`);
    const entries = window.history.length;
    renderDiagram({ state: "current" });
    await screen.findByRole("region", { name: "Diagram" });
    const inspector = within(screen.getByRole("complementary"));
    await waitFor(() =>
      // The method and the path are separate spans.
      expect(inspector.getByRole("heading", { level: 2 }).textContent).toBe("POST/api/orders"),
    );
    expect(window.location.search).toBe(link);
    expect(document.querySelector(".diagram-page__note")).toBeNull();
    // Esc goes up a level: the link drops `open`, keeping the path and hash.
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe("?sel=route:api/POST%20/api/orders"));
    expect(window.location.pathname).toBe("/acme/shop");
    expect(window.location.hash).toBe("#top");
    expect(window.history.length).toBe(entries);
    // Clearing the selection leaves no query at all.
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("says what part of a link this commit doesn't have, until dismissed", async () => {
    fetchMock.mockImplementation(graphResponse);
    window.history.replaceState({}, "", "/acme/shop?sel=route:api/GET%20/gone&hideLayers=space");
    renderDiagram({ state: "current" });
    await screen.findByRole("region", { name: "Diagram" });
    const note = document.querySelector(".diagram-page__note");
    expect(note?.textContent).toBe(
      "Part of this link doesn't apply to commit aaaaaaa, so it was left out: selected route:api/GET /gone; hidden layer space.",
    );
    // The rest of the diagram opens as usual.
    const inspector = within(screen.getByRole("complementary"));
    expect(inspector.getByRole("heading", { level: 2 }).textContent).toBe("shop-demo");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".diagram-page__note")).toBeNull();
  });

  it("shares the commit's permalink with the current state from the repo bar", async () => {
    fetchMock.mockImplementation(graphResponse);
    window.history.replaceState({}, "", "/acme/shop?open=service:api/");
    renderDiagram({ state: "current" });
    await screen.findByRole("region", { name: "Diagram" });
    const share = screen.getByRole("button", { name: "Share" });
    fireEvent.click(share);
    const field = () =>
      (screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement).value;
    const origin = window.location.origin;
    expect(field()).toBe(`${origin}/acme/shop/${SHA}?open=service:api/`);
    // Close it, go up a level, and share again: the link follows the view.
    fireEvent.click(share);
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(""));
    fireEvent.click(share);
    expect(field()).toBe(`${origin}/acme/shop/${SHA}`);
  });

  it("exports the view the explorer has drawn from the repo bar's share menu", async () => {
    fetchMock.mockImplementation(graphResponse);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    window.history.replaceState({}, "", "/acme/shop?open=service:api/");
    renderDiagram({ state: "current" });
    await screen.findByRole("region", { name: "Diagram" });
    await waitFor(
      () => expect(document.querySelector(".gi-drill")?.getAttribute("data-layout")).toBe("done"),
      // 5 s alone here, 13 s in a full parallel `pnpm test`.
      { timeout: 25_000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const exporting = within(screen.getByRole("group", { name: "Export this view" }));
    await act(async () => fireEvent.click(exporting.getByRole("button", { name: "Copy Mermaid" })));
    const mermaid = writeText.mock.lastCall?.[0] ?? "";
    // The level on screen: the api broken down, its routes inside.
    expect(mermaid).toMatch(/^%% fixtures\/shop-demo, drawn by GitInside/);
    expect(mermaid).toMatch(/subgraph n\d+ \["@shop\/api"\]/);
    expect(mermaid).toContain("POST /api/orders");
    // ELK on the main thread, under coverage too: no shorter than the wait above.
  }, 30_000);

  it("stops loading when it goes away", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    });
    const { unmount } = renderDiagram({ state: "current" });
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("AddToReadme", () => {
  const origin = window.location.origin;
  const openPanel = () => {
    render(<AddToReadme owner="acme" repo="shop" />);
    const button = screen.getByRole("button", { name: "Add to README" });
    fireEvent.click(button);
    return button;
  };
  const markdown = () => screen.getByLabelText("Markdown").textContent;

  it("is on the repo bar of a diagram", async () => {
    fetchMock.mockImplementation(graphResponse);
    render(
      <RepoDiagram
        owner="acme"
        repo="shop"
        sha={SHA}
        graphUrl={GRAPH_URL}
        head={{ state: "current" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Add to README" })).toBeTruthy();
    await screen.findByRole("region", { name: "Diagram" });
  });

  it("opens with the badge's Markdown on this site, and a preview of it", () => {
    const button = openPanel();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Add to README" });
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(markdown()).toBe(readmeMarkdown("badge", origin, "acme", "shop"));
    expect(within(panel).getByRole("img").getAttribute("src")).toBe(
      `${origin}/api/badge/acme/shop.svg`,
    );
  });

  it("switches to the live image, previewed in the site's theme", () => {
    document.documentElement.dataset["theme"] = "light";
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "Live image" }));
    expect(markdown()).toBe(readmeMarkdown("image", origin, "acme", "shop"));
    expect(markdown()).toContain("<picture>");
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      `${origin}/api/diagram/acme/shop.svg?theme=light`,
    );
    delete document.documentElement.dataset["theme"];
  });

  it("copies the Markdown, says so, and goes back to Copy", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openPanel();
    // The clipboard answers in a microtask; act flushes it without moving the clock.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(readmeMarkdown("badge", origin, "acme", "shop"));
    expect(screen.getByRole("status").textContent).toBe(COPIED_MESSAGE);
    await act(() => vi.advanceTimersByTimeAsync(COPIED_MS - 1));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    vi.useRealTimers();
  });

  it("selects the Markdown when the browser refuses to copy", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("no"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(COPY_FAILED_MESSAGE));
    expect(window.getSelection()?.toString()).toBe(markdown());
    // Choosing the other snippet clears the old message.
    fireEvent.click(screen.getByRole("radio", { name: "Live image" }));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("closes on Esc, returning focus to its button", () => {
    const button = openPanel();
    const radio = screen.getByRole("radio", { name: "Badge" });
    radio.focus();
    fireEvent.keyDown(radio, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Add to README" })).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside or on its button, leaving focus where it is", () => {
    const button = openPanel();
    fireEvent.pointerDown(screen.getByLabelText("Markdown"));
    expect(screen.getByRole("region", { name: "Add to README" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "Add to README" })).toBeNull();
    expect(document.activeElement).not.toBe(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Add to README" })).toBeNull();
  });
});

describe("NotAnalyzed", () => {
  it("starts an analysis and opens its progress page", async () => {
    fetchMock.mockImplementation(() =>
      analyzeResponse(202, { status: "queued", jobId: JOB, owner: "acme", repo: "shop" }),
    );
    render(<NotAnalyzed owner="acme" repo="shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ url: "acme/shop" });
  });

  it("fetches this page again if the repo was analyzed meanwhile", async () => {
    fetchMock.mockImplementation(() =>
      analyzeResponse(200, { status: "done", owner: "acme", repo: "shop", sha: SHA }),
    );
    render(<NotAnalyzed owner="acme" repo="shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says a refusal in place and ignores clicks while one is in flight", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    render(<NotAnalyzed owner="acme" repo="shop" />);
    const button = screen.getByRole("button", { name: "Analyze" });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(new Response(JSON.stringify({ message: UNAVAILABLE_MESSAGE }), { status: 503 }));
    expect((await screen.findByRole("alert")).textContent).toBe(UNAVAILABLE_MESSAGE);
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/acme/shop",
    );
  });
});
