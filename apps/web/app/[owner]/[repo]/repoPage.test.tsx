import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import brokenBase from "../../../../../fixtures/diff-broken-base/expected.json";
import brokenHead from "../../../../../fixtures/diff-broken-head/expected.json";
import shopDemo from "../../../../../fixtures/shop-demo/expected.json";
import { UNAVAILABLE_MESSAGE } from "../../../lib/messages";
import { readmeMarkdown } from "../../../lib/readme";
import {
  LOAD_FAILED_MESSAGE,
  LOAD_FAILED_TITLE,
  UNREADABLE_MESSAGE,
  UNREADABLE_TITLE,
} from "../../../lib/repoStatus";
import {
  RepoAccessUnavailableError,
  viewBase,
  viewRepo,
  type RepoView,
  type RepoViewDeps,
} from "../../../lib/repoView";
import type { AuthDeps } from "../../../lib/authRoute";
import { authDepsFromEnv, repoViewDepsFromEnv } from "../../../lib/serverDeps";
import type { TurnstileOptions } from "../../../lib/turnstile";
import { CHECK_FAILED_MESSAGE } from "../../BotCheck";
import CommitPage, { generateMetadata as commitMetadata } from "./[sha]/page";
import { AddToReadme, COPIED_MESSAGE, COPIED_MS, COPY_FAILED_MESSAGE } from "./AddToReadme";
import { NotAnalyzed } from "./NotAnalyzed";
import RepoPage, { generateMetadata as repoMetadata } from "./page";
import { RepoDiagram } from "./RepoDiagram";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("../../../lib/serverDeps", () => ({
  authDepsFromEnv: vi.fn(),
  repoViewDepsFromEnv: vi.fn(),
  VERCEL_OIDC_HEADER: "x-vercel-oidc-token",
}));
// Vercel's OIDC token arrives with the page's request (ADR-0142), and the viewer's cookie.
const request = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-vercel-oidc-token": "page-oidc",
      ...(request.cookie !== undefined && { cookie: request.cookie }),
    }),
}));
vi.mock("../../../lib/repoView", async (original) => ({
  ...(await original<typeof import("../../../lib/repoView")>()),
  viewRepo: vi.fn(),
  viewBase: vi.fn(),
}));

// Cloudflare's script never loads in tests: a fake `window.turnstile` stands in.
const turnstile = {
  render: vi.fn<(container: HTMLElement, options: TurnstileOptions) => string>(),
  remove: vi.fn<(id: string) => void>(),
};
const { loadTurnstile } = vi.hoisted(() => ({ loadTurnstile: vi.fn() }));
vi.mock("../../../lib/turnstile", async (original) => ({
  ...(await original<typeof import("../../../lib/turnstile")>()),
  loadTurnstile,
}));
beforeEach(() => {
  turnstile.render.mockReset().mockReturnValue("widget-1");
  turnstile.remove.mockReset();
  loadTurnstile.mockReset().mockResolvedValue(turnstile);
});

const CHALLENGE_MESSAGE = "GitInside is busier than usual, so we're checking that you're a person.";
const challenged = { error: "CHALLENGE_REQUIRED", message: CHALLENGE_MESSAGE, siteKey: "0x4AAA" };

/** The options the widget was drawn with, once the bot check is on screen. */
async function widgetOptions(): Promise<TurnstileOptions> {
  await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
  const [container, options] = turnstile.render.mock.calls[0]!;
  expect(container).toBe(screen.getByTestId("bot-check"));
  expect(options).toMatchObject({ sitekey: "0x4AAA", action: "analyze" });
  return options;
}

const SHA = "a".repeat(40);
const NEWER = "b".repeat(40);
const BASE = "d".repeat(40);
const GRAPH_URL = `/api/graph/acme/shop/${SHA}`;
const BASE_URL = `/api/graph/acme/shop/${BASE}`;
const JOB = `analyze-${"c".repeat(32)}`;
const db = {} as RepoViewDeps["db"];
const deps = { db } as RepoViewDeps;

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
  vi.mocked(viewBase).mockReset();
  vi.mocked(authDepsFromEnv).mockReset();
  request.cookie = undefined;
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
    // Check-on-view enqueues with the request's own OIDC token.
    expect(repoViewDepsFromEnv).toHaveBeenCalledWith(process.env, "page-oidc");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme / Shop");
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });

  it("redirects a renamed repo's old name to its new one, keeping the link's query (M5.13b3)", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "moved", owner: "Shopco", repo: "Store" });
    const searchParams = Promise.resolve({ sel: "service:api/", base: BASE });
    await expect(RepoPage({ params: params("acme", "shop"), searchParams })).rejects.toThrow(
      `NEXT_REDIRECT /Shopco/Store?sel=service%3Aapi%2F&base=${BASE}`,
    );
    expect(viewBase).not.toHaveBeenCalled();
  });

  it("draws the diagram of a ready repo", async () => {
    fetchMock.mockImplementation(graphResponse);
    vi.mocked(viewRepo).mockResolvedValue(ready({ state: "current" }));
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(GRAPH_URL, expect.anything());
    expect(viewBase).not.toHaveBeenCalled();
  });

  it("looks up the link's base for a ready repo, the last of a repeated one (M6.9e2)", async () => {
    fetchMock.mockImplementation(graphResponse);
    const view = ready({ state: "current" });
    vi.mocked(viewRepo).mockResolvedValue(view);
    vi.mocked(viewBase).mockResolvedValue({ status: "missing", sha: BASE });
    const searchParams = Promise.resolve({ base: ["x", BASE], sel: "service:api/" });
    render(await RepoPage({ params: params("acme", "shop"), searchParams }));
    expect(viewBase).toHaveBeenCalledWith(view, BASE, db);
    await screen.findByRole("region", { name: "Diagram" });
    expect(document.querySelector(".diagram-page__note")?.textContent).toContain(
      "Commit ddddddd hasn't been analyzed",
    );
  });

  it("doesn't look up a base for a repo with no diagram, and says a failed lookup like any", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "not-analyzed", owner: "acme", repo: "shop" });
    const searchParams = Promise.resolve({ base: BASE });
    render(await RepoPage({ params: params("acme", "shop"), searchParams }));
    expect(viewBase).not.toHaveBeenCalled();
    cleanup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(viewRepo).mockResolvedValue(ready({ state: "current" }));
    vi.mocked(viewBase).mockRejectedValue(new TypeError("postgres://user:secret@host"));
    render(await RepoPage({ params: params("acme", "shop"), searchParams }));
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "repo_view_failed", error: "TypeError" }),
    );
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

  it("looks up the link's base too (M6.9e2)", async () => {
    const view = ready({ state: "pinned" });
    vi.mocked(viewRepo).mockResolvedValue(view);
    vi.mocked(viewBase).mockResolvedValue({ status: "invalid" });
    fetchMock.mockImplementation(graphResponse);
    const searchParams = Promise.resolve({ base: "main" });
    render(await CommitPage({ params: commitParams("acme", "shop", SHA), searchParams }));
    expect(viewBase).toHaveBeenCalledWith(view, "main", db);
    await screen.findByRole("region", { name: "Diagram" });
    expect(document.querySelector(".diagram-page__note")?.textContent).toContain(
      "The link's base isn't a full commit SHA",
    );
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
    vi.mocked(viewRepo).mockResolvedValue(ready({ state: "pinned" }));
    expect(await commitMetadata({ params: commitParams("acme", "shop", SHA) })).toEqual({
      title: "acme/shop at aaaaaaa",
    });
    expect(await commitMetadata({ params: commitParams("acme", "shop", "main") })).toEqual({});
  });
});

describe("private repo pages (M8.4c1)", () => {
  const auth = { db } as AuthDeps;
  const shownPrivate = (head: Extract<RepoView, { status: "ready" }>["head"]): RepoView => ({
    ...(ready(head) as Extract<RepoView, { status: "ready" }>),
    private: { providerRepoId: 77 },
  });
  const NOINDEX = "noindex, nofollow";

  it("views as the request's cookie when sign-in is configured, else as nobody", async () => {
    vi.mocked(viewRepo).mockResolvedValue({ status: "missing" });
    request.cookie = "theme=dark; __Host-gitinside_session=abc";
    await expect(RepoPage({ params: params("acme", "shop") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(viewRepo).toHaveBeenLastCalledWith({ owner: "acme", repo: "shop" }, deps);

    vi.mocked(authDepsFromEnv).mockReturnValue(auth);
    await expect(CommitPage({ params: commitParams("acme", "shop", SHA) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(viewRepo).toHaveBeenLastCalledWith(
      { owner: "acme", repo: "shop", sha: SHA },
      { ...deps, viewer: { cookie: request.cookie, auth } },
    );
    request.cookie = undefined;
    await expect(RepoPage({ params: params("acme", "shop") })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(viewRepo).toHaveBeenLastCalledWith(
      { owner: "acme", repo: "shop" },
      { ...deps, viewer: { cookie: null, auth } },
    );
  });

  it("draws a private repo shown to its viewer, comparing within it", async () => {
    vi.mocked(authDepsFromEnv).mockReturnValue(auth);
    fetchMock.mockImplementation(graphResponse);
    const view = shownPrivate({ state: "unknown" });
    vi.mocked(viewRepo).mockResolvedValue(view);
    vi.mocked(viewBase).mockResolvedValue({ status: "missing", sha: BASE });
    const searchParams = Promise.resolve({ base: BASE });
    render(await RepoPage({ params: params("acme", "shop"), searchParams }));
    expect(viewBase).toHaveBeenCalledWith(view, BASE, db);
    expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(GRAPH_URL, expect.anything());
  });

  it("says unavailable when a private repo's check can't decide, logging its name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authDepsFromEnv).mockReturnValue(auth);
    vi.mocked(viewRepo).mockRejectedValue(new RepoAccessUnavailableError());
    render(await CommitPage({ params: commitParams("acme", "shop", SHA) }));
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: "repo_view_failed", error: "RepoAccessUnavailableError" }),
    );
  });

  it("keeps a private repo shown to its viewer out of search engines, and nothing else", async () => {
    vi.mocked(authDepsFromEnv).mockReturnValue(auth);
    fetchMock.mockImplementation(graphResponse);
    const robots = () => document.querySelector('meta[name="robots"]')?.getAttribute("content");
    vi.mocked(viewRepo).mockResolvedValue(shownPrivate({ state: "unknown" }));
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(robots()).toBe(NOINDEX);
    cleanup();
    vi.mocked(viewRepo).mockResolvedValue(shownPrivate({ state: "pinned" }));
    render(await CommitPage({ params: commitParams("acme", "shop", SHA) }));
    expect(robots()).toBe(NOINDEX);
    cleanup();
    // A page not shown carries exactly what a missing repo's does: no robots tag.
    const others: RepoView[] = [
      ready({ state: "current" }),
      { status: "not-analyzed", owner: "acme", repo: "shop" },
    ];
    for (const view of others) {
      vi.mocked(viewRepo).mockResolvedValue(view);
      render(await RepoPage({ params: params("acme", "shop") }));
      expect(robots()).toBeUndefined();
      cleanup();
    }
  });

  it("titles the tab from the path alone, never viewing the repo (a prefetch resolves metadata)", async () => {
    vi.mocked(authDepsFromEnv).mockReturnValue(auth);
    vi.mocked(viewRepo).mockResolvedValue(shownPrivate({ state: "unknown" }));
    expect(await repoMetadata({ params: params("acme", "shop") })).toEqual({ title: "acme/shop" });
    expect(await commitMetadata({ params: commitParams("acme", "shop", SHA) })).toEqual({
      title: "acme/shop at aaaaaaa",
    });
    expect(viewRepo).not.toHaveBeenCalled();
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
    expect(
      screen.getByText(
        /took over 3\smin 50\ss, the limit for one repo\. A repo with many services/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analyze again" })).toBeNull();
  });

  it("runs the bot check for Analyze again when asked (M5 review R2)", async () => {
    fetchMock.mockImplementation((url) =>
      url === "/api/analyze" ? analyzeResponse(403, challenged) : graphResponse(),
    );
    renderDiagram({ state: "behind", sha: NEWER, reason: "failed", errorCode: "DOWNLOAD_FAILED" });
    await screen.findByRole("region", { name: "Diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Analyze again" }));
    const options = await widgetOptions();
    expect(screen.getByText(CHALLENGE_MESSAGE).getAttribute("role")).toBe("status");
    fetchMock.mockImplementation((url) =>
      url === "/api/analyze"
        ? analyzeResponse(202, { status: "queued", jobId: JOB, owner: "acme", repo: "shop" })
        : graphResponse(),
    );
    act(() => options.callback("tok.en"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
    const asks = fetchMock.mock.calls.filter(([url]) => url === "/api/analyze");
    expect(JSON.parse(String(asks[1]?.[1]?.body))).toEqual({
      url: "acme/shop",
      turnstileToken: "tok.en",
    });
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

  it("announces the note through a live region that was there before it, emptied on dismiss", async () => {
    fetchMock.mockImplementation(graphResponse);
    window.history.replaceState({}, "", "/acme/shop?hideLayers=space");
    const { container } = renderDiagram({ state: "current" });
    // Mounted empty with the page, so filling it is a change a screen reader reads out.
    const live = container.querySelector('.diagram-page [aria-live="polite"]');
    expect(live?.textContent).toBe("");
    await screen.findByRole("region", { name: "Diagram" });
    expect(live?.textContent).toBe(
      "Part of this link doesn't apply to commit aaaaaaa, so it was left out: hidden layer space.",
    );
    // Browse mode reads it once (M4b.16): the visible copy is hidden from screen readers.
    const shown = document.querySelector(".diagram-page__note p");
    expect(shown?.textContent).toBe(live?.textContent);
    expect(shown?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(live?.isConnected).toBe(true);
    expect(live?.textContent).toBe("");
  });

  it("moves focus into the diagram when the note's focused Dismiss goes", async () => {
    fetchMock.mockImplementation(graphResponse);
    window.history.replaceState({}, "", "/acme/shop?hideLayers=space");
    renderDiagram({ state: "current" });
    const diagram = await screen.findByRole("region", { name: "Diagram" });
    // The explorer's main-thread layout: 5 s alone, 13 s in a full parallel `pnpm test`.
    await waitFor(
      () => expect(diagram.querySelector(".gi-drill__node [tabindex='0']")).not.toBeNull(),
      { timeout: 25_000 },
    );
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(document.activeElement).not.toBe(document.body);
    expect(diagram.contains(document.activeElement)).toBe(true);
  }, 30_000);

  it("never has Add to README and Share open at once", async () => {
    fetchMock.mockImplementation(graphResponse);
    renderDiagram({ state: "current" });
    await screen.findByRole("region", { name: "Diagram" });
    const readme = screen.getByRole("button", { name: "Add to README" });
    const share = screen.getByRole("button", { name: "Share" });
    // Keyboard presses: no pointer lands outside either menu to close the other.
    fireEvent.click(readme);
    expect(readme.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(share);
    expect(share.getAttribute("aria-expanded")).toBe("true");
    expect(readme.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Add to README" })).toBeNull();
    fireEvent.click(readme);
    expect(readme.getAttribute("aria-expanded")).toBe("true");
    expect(share.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('.gi-share[data-state="open"]')).toBeNull();
    // Esc closes the one that's open, and then neither is.
    fireEvent.keyDown(screen.getByLabelText("Markdown"), { key: "Escape" });
    expect(readme.getAttribute("aria-expanded")).toBe("false");
    expect(share.getAttribute("aria-expanded")).toBe("false");
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

describe("RepoDiagram in diff mode (M6.9e2)", () => {
  /** A diff fixture's graph as the worker stores it: this repo, at `sha`. */
  const stored = (json: object, sha: string, over: object = {}) =>
    new Response(JSON.stringify({ ...json, repo: { owner: "acme", name: "shop", sha }, ...over }));
  /** Answers head's and base's graph URLs with the diff-broken pair (base's changed by `over`). */
  const pair =
    (over: object = {}) =>
    (url: string | URL | Request) =>
      url === GRAPH_URL
        ? Promise.resolve(stored(brokenHead, SHA))
        : url === BASE_URL
          ? Promise.resolve(stored(brokenBase, BASE, over))
          : Promise.reject(new Error(`unexpected fetch ${String(url)}`));
  const READY = { status: "ready", sha: BASE, graphUrl: BASE_URL } as const;
  const renderDiagram = (base: Parameters<typeof RepoDiagram>[0]["base"]) =>
    render(
      <RepoDiagram
        owner="acme"
        repo="shop"
        sha={SHA}
        graphUrl={GRAPH_URL}
        head={{ state: "pinned" }}
        base={base}
      />,
    );
  const chip = () => document.querySelector(".gi-status[data-tone='diff']")?.textContent;
  const shared = () => {
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const field = screen.getByRole("textbox", { name: "Link to this view" }) as HTMLInputElement;
    const link = field.value;
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    return link;
  };
  const note = () => document.querySelector(".diagram-page__note")?.textContent;

  it("loads both commits' graphs and draws the changes between them", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    expect(fetchMock).toHaveBeenCalledWith(GRAPH_URL, expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(BASE_URL, expect.anything());
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    expect(note()).toBeUndefined();
  });

  it("opens a link to a route only base has, linked at the base commit", async () => {
    fetchMock.mockImplementation(pair());
    const link = `?base=${BASE}&sel=route:diff-broken/GET%20/api/health`;
    window.history.replaceState({}, "", `/acme/shop/${SHA}${link}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    const inspector = within(screen.getByRole("complementary"));
    await waitFor(() =>
      expect(inspector.getByRole("heading", { level: 2 }).textContent).toBe("GET/api/health"),
    );
    // Decoded against both versions: the removed route isn't "left out".
    expect(note()).toBeUndefined();
    expect(inspector.getByRole("link", { name: /Open on GitHub/ }).getAttribute("href")).toBe(
      `https://github.com/acme/shop/blob/${BASE}/src/server.ts#L9`,
    );
    expect(window.location.search).toBe(link);
  });

  it("keeps the base first in the address bar and in Copy link as the view changes", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}&sel=service:diff-broken/`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    const origin = window.location.origin;
    expect(shared()).toBe(`${origin}/acme/shop/${SHA}?base=${BASE}&sel=service:diff-broken/`);
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(`?base=${BASE}`));
    expect(shared()).toBe(`${origin}/acme/shop/${SHA}?base=${BASE}`);
  });

  it("switches Base, Head, Overlay on the canvas, keeping the version in the link (M6.9e2b)", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    fireEvent.click(within(views).getByRole("radio", { name: "Head" }));
    await waitFor(() => expect(window.location.search).toBe(`?base=${BASE}&view=head`));
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}?base=${BASE}&view=head`);
    fireEvent.click(within(views).getByRole("radio", { name: "Overlay" }));
    await waitFor(() => expect(window.location.search).toBe(`?base=${BASE}`));
  });

  it("opens on the version a link names", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}&view=base`);
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Base"]);
    expect(note()).toBeUndefined();
  });

  it("names the base commit on the repo bar, linked to GitHub, with a way to stop comparing", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState(
      {},
      "",
      `/acme/shop?base=${BASE}&view=head&sel=service:diff-broken/`,
    );
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const compare = document.querySelector(".repo-bar__compare") as HTMLElement;
    expect(compare.textContent).toBe("compared withdddddddStop comparing");
    expect(within(compare).getByRole("link", { name: "ddddddd" }).getAttribute("href")).toBe(
      `https://github.com/acme/shop/tree/${BASE}`,
    );
    // This commit's permalink with the same state, without the base or its view.
    const stop = within(compare).getByRole("link", { name: "Stop comparing" });
    expect(stop.getAttribute("href")).toBe(`/acme/shop/${SHA}?sel=service:diff-broken/`);
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(stop.getAttribute("href")).toBe(`/acme/shop/${SHA}`));
  });

  it("keeps a view with a base not analyzed yet, and drops one without a base", async () => {
    fetchMock.mockImplementation(pair());
    const link = `?base=${BASE}&view=head`;
    window.history.replaceState({}, "", `/acme/shop/${SHA}${link}&sel=service:diff-broken/`);
    renderDiagram({ status: "missing", sha: BASE });
    await screen.findByRole("region", { name: "Diagram" });
    // The explorer, comparing nothing, reports the Overlay; the link keeps the view.
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(link));
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}${link}`);
    cleanup();

    window.history.replaceState({}, "", `/acme/shop/${SHA}?view=head`);
    renderDiagram(undefined);
    await screen.findByRole("region", { name: "Diagram" });
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}`);
  });

  it("offers Stop comparing, without a base chip, for a base it couldn't compare", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram({ status: "missing", sha: BASE });
    await screen.findByRole("region", { name: "Diagram" });
    const compare = document.querySelector(".repo-bar__compare") as HTMLElement;
    expect(compare.textContent).toBe("Stop comparing");
    cleanup();
    // Without a base, nothing.
    renderDiagram(undefined);
    await screen.findByRole("region", { name: "Diagram" });
    expect(document.querySelector(".repo-bar__compare")).toBeNull();
  });

  it("says a base nobody analyzed isn't compared, draws this commit alone, and keeps it in the link", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram({ status: "missing", sha: BASE });
    await screen.findByRole("region", { name: "Diagram" });
    expect(note()).toBe(
      "Commit ddddddd hasn't been analyzed, so there's nothing to compare with. This is commit aaaaaaa alone.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chip()).toBeUndefined();
    // Once it's analyzed, the same link compares.
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}?base=${BASE}`);
  });

  it("says a malformed base isn't compared, and leaves it out of the link", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=main&sel=service:diff-broken/`);
    renderDiagram({ status: "invalid" });
    await screen.findByRole("region", { name: "Diagram" });
    expect(note()).toBe(
      "The link's base isn't a full commit SHA, so nothing was compared. This is commit aaaaaaa alone.",
    );
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}?sel=service:diff-broken/`);
    fireEvent.keyDown(document.querySelector(".gi-explorer") as Element, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("doesn't compare graphs from two analyzer versions, and says why next to what the link lost", async () => {
    fetchMock.mockImplementation(pair({ analyzerVersion: "0.0.9" }));
    // Without the comparison, base's route is a node this commit doesn't have.
    const link = `?base=${BASE}&sel=route:diff-broken/GET%20/api/health`;
    window.history.replaceState({}, "", `/acme/shop/${SHA}${link}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    expect(note()).toBe(
      `Commit ddddddd was analyzed by GitInside 0.0.9 and this one by ${brokenHead.analyzerVersion}, so they aren't compared: the differences would be the analyzer's, not the code's. This is commit aaaaaaa alone. ` +
        "Part of this link doesn't apply to commit aaaaaaa, so it was left out: selected route:diff-broken/GET /api/health.",
    );
    expect(chip()).toBeUndefined();
  });

  it("keeps this commit on screen when the base fails to load, and tries the base again (M6.11h)", async () => {
    const unavailable = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Base unavailable." }), { status: 503 }),
      );
    fetchMock.mockImplementation((url) => (url === BASE_URL ? unavailable() : pair()(url)));
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}&view=head`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(note()).toBe(
      "Commit ddddddd's diagram didn't load, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.Try again",
    );
    expect(chip()).toBeUndefined();
    // Not compared yet, so the link still asks for the base and its view.
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}?base=${BASE}&view=head`);

    // Try again in the note loads the base alone; once it's here, the two compare.
    fetchMock.mockClear().mockImplementation(pair());
    const again = within(document.querySelector(".diagram-page__note") as HTMLElement);
    const button = again.getByRole("button", { name: "Try again" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([BASE_URL]);
    expect(note()).toBeUndefined();
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Head"]);
    // The button went with the note: focus goes on to the compared diagram, not `<body>` (M6.11m).
    expect(document.activeElement).not.toBe(document.body);
    const box = () => document.querySelector<HTMLElement>(".gi-drill__node [tabindex='0']");
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    await waitFor(() => expect(document.activeElement).toBe(box()));
  }, 60_000);

  it("hands focus from the base's Try again to the diagram in the render that takes the button away (M7.2c2a)", async () => {
    const unavailable = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Base unavailable." }), { status: 503 }),
      );
    fetchMock.mockImplementation((url) => (url === BASE_URL ? unavailable() : pair()(url)));
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    fetchMock.mockClear().mockImplementation(pair());
    const button = within(document.querySelector(".diagram-page__note") as HTMLElement).getByRole(
      "button",
      { name: "Try again" },
    );
    button.focus();
    // The base lands outside act, with React's Scheduler yielding after every task, so passive
    // effects wait for a later task, as on a loaded machine (CI run 42340377659): focus is read
    // as soon as the button leaves the page.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    let time = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (time += 10));
    onTestFinished(() => {
      clock.mockRestore();
      env.IS_REACT_ACT_ENVIRONMENT = true;
    });
    const focused = await new Promise<Element | null>((resolve) => {
      new MutationObserver((_, observer) => {
        if (button.isConnected) return;
        observer.disconnect();
        resolve(document.activeElement);
      }).observe(document.body, { subtree: true, childList: true });
      button.click();
    });
    clock.mockRestore();
    env.IS_REACT_ACT_ENVIRONMENT = true;
    expect(focused).not.toBe(document.body);
    expect(document.querySelector(".diagram-page__canvas")?.contains(focused)).toBe(true);
    const box = () => document.querySelector<HTMLElement>(".gi-drill__node [tabindex='0']");
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    await waitFor(() => expect(document.activeElement).toBe(box()));
  }, 60_000);

  it("says each failed Try again of the base in new words, so it's announced (M6.11m)", async () => {
    const unavailable = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Base unavailable." }), { status: 503 }),
      );
    fetchMock.mockImplementation((url) => (url === BASE_URL ? unavailable() : pair()(url)));
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    const live = () => document.querySelector("[aria-live='polite']")?.textContent;
    const first =
      "Commit ddddddd's diagram didn't load, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.";
    expect(live()).toBe(first);
    const retry = () =>
      within(document.querySelector(".diagram-page__note") as HTMLElement).getByRole("button", {
        name: "Try again",
      });
    fireEvent.click(retry());
    await waitFor(() =>
      expect(live()).toBe(
        "Commit ddddddd's diagram still didn't load after 2 tries, so nothing was compared: Base unavailable. This is commit aaaaaaa alone.",
      ),
    );
    fireEvent.click(retry());
    await waitFor(() => expect(live()).toContain("still didn't load after 3 tries"));
    // Focus stays on the button, which is still there.
    retry().focus();
    fireEvent.click(retry());
    await waitFor(() => expect(live()).toContain("after 4 tries"));
    expect(document.activeElement).toBe(retry());
  });

  it("offers no Try again for a base that can't be read, and leaves this commit on screen", async () => {
    fetchMock.mockImplementation((url) =>
      url === BASE_URL ? Promise.resolve(new Response("{}")) : pair()(url),
    );
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    renderDiagram(READY);
    await screen.findByRole("region", { name: "Diagram" });
    expect(note()).toBe(
      "Commit ddddddd's saved diagram couldn't be read, so nothing was compared. This is commit aaaaaaa alone.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("still puts a failed load of this commit on the card, whatever the base did", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 503 })));
    renderDiagram(READY);
    const card = await screen.findByRole("alert");
    expect(within(card).getByRole("heading", { level: 2 }).textContent).toBe(LOAD_FAILED_TITLE);
    expect(screen.queryByRole("region", { name: "Diagram" })).toBeNull();
    fetchMock.mockImplementation(pair());
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("opens a linked Base or Head that lacks the link's selection on the Overlay, says so, and links what's shown (M6.11h)", async () => {
    fetchMock.mockImplementation(pair());
    // The route only base has, with Head asked for.
    const sel = "sel=route:diff-broken/GET%20/api/health";
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}&view=head&${sel}`);
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const views = screen.getByRole("radiogroup", { name: "Diff view" });
    const checked = within(views)
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["Overlay"]);
    expect(note()).toBe(
      "The link opens on Head, which doesn't have the selected route GET /api/health, so both versions are shown (Overlay).",
    );
    // Copy link names the Overlay on screen, not the Head the link asked for.
    expect(shared()).toBe(`${window.location.origin}/acme/shop/${SHA}?base=${BASE}&${sel}`);
  });

  it("moves focus to the diagram after Stop comparing, on the same page or a new one (M6.11h)", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    const { rerender } = renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const stop = () => screen.getByRole("link", { name: "Stop comparing" });
    const box = () => document.querySelector<HTMLElement>(".gi-drill__node [tabindex='0']");
    const page = (base: Parameters<typeof RepoDiagram>[0]["base"]) => (
      <RepoDiagram
        owner="acme"
        repo="shop"
        sha={SHA}
        graphUrl={GRAPH_URL}
        head={{ state: "pinned" }}
        base={base}
      />
    );
    // The link goes with the comparison; focus waits on the diagram while it loads, then a box.
    stop().focus();
    fireEvent.click(stop());
    window.history.replaceState({}, "", `/acme/shop/${SHA}`);
    rerender(page(undefined));
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    await waitFor(() => expect(document.activeElement).toBe(box()));
    cleanup();

    // From the latest commit's page, the permalink is another page: a new diagram takes it up.
    window.history.replaceState({}, "", `/acme/shop?base=${BASE}`);
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    stop().focus();
    fireEvent.click(stop());
    cleanup();
    window.history.replaceState({}, "", `/acme/shop/${SHA}`);
    renderDiagram(undefined);
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    await waitFor(() => expect(document.activeElement).toBe(box()));
    cleanup();

    // A base never analyzed reloads nothing when it goes: the diagram on screen takes focus.
    window.history.replaceState({}, "", `/acme/shop/${SHA}?base=${BASE}`);
    const missing = renderDiagram({ status: "missing", sha: BASE });
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    stop().focus();
    fireEvent.click(stop());
    window.history.replaceState({}, "", `/acme/shop/${SHA}`);
    missing.rerender(page(undefined));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    cleanup();

    // Without Stop comparing, a diagram leaves focus where it is.
    renderDiagram(undefined);
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    expect(document.activeElement).toBe(document.body);
  }, 60_000);

  it("drops Stop comparing's focus once a diagram with no box is drawn, leaving later ones be (M6.11m)", async () => {
    fetchMock.mockImplementation(pair());
    window.history.replaceState({}, "", `/acme/shop?base=${BASE}`);
    renderDiagram(READY);
    await waitFor(() => expect(chip()).toBe("Comparing ddddddd → aaaaaaa"));
    const stop = screen.getByRole("link", { name: "Stop comparing" });
    stop.focus();
    fireEvent.click(stop);
    cleanup();

    // This commit's permalink is a repo with no app: the explorer's card, no box to focus.
    const noApp = {
      ...brokenHead,
      nodes: brokenHead.nodes.filter((n) => ["system", "service"].includes(n.kind)),
      edges: [],
    };
    fetchMock.mockImplementation(() => Promise.resolve(stored(noApp, SHA)));
    window.history.replaceState({}, "", `/acme/shop/${SHA}`);
    renderDiagram(undefined);
    await screen.findByText("We couldn't find a TypeScript or JavaScript app here");
    const host = document.querySelector(".diagram-page__canvas") as HTMLElement;
    // Focus waits on the diagram's spot, and stays there for now: there's nowhere better.
    await waitFor(() => expect(document.activeElement).toBe(host));
    fireEvent.blur(host);
    expect(host.hasAttribute("tabindex")).toBe(false);
    cleanup();

    // The next diagram drawn in this tab isn't Stop comparing's: it leaves focus where it is.
    fetchMock.mockImplementation(pair());
    renderDiagram(undefined);
    const box = () => document.querySelector<HTMLElement>(".gi-drill__node [tabindex='0']");
    await waitFor(() => expect(box()).not.toBeNull(), { timeout: 25_000 });
    expect(document.activeElement).toBe(document.body);
  }, 60_000);
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

  it("goes back to Copy when the repo bar closes it (M4b.16)", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { rerender } = render(<AddToReadme owner="acme" repo="shop" open />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    // The share menu opening closes it from outside, then it opens again at once.
    rerender(<AddToReadme owner="acme" repo="shop" open={false} />);
    rerender(<AddToReadme owner="acme" repo="shop" open />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
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

  it("runs the bot check when asked, then analyzes with its token (M5 review R2)", async () => {
    fetchMock
      .mockImplementationOnce(() => analyzeResponse(403, challenged))
      .mockImplementationOnce(() =>
        analyzeResponse(202, { status: "queued", jobId: JOB, owner: "acme", repo: "shop" }),
      );
    render(<NotAnalyzed owner="acme" repo="shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const options = await widgetOptions();
    // Said calmly, as a status, not as a refusal.
    expect(screen.getByRole("status").textContent).toBe(CHALLENGE_MESSAGE);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => options.callback("tok.en"));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      url: "acme/shop",
      turnstileToken: "tok.en",
    });
    expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
  });

  it("drops the bot check and asks afresh when Analyze is pressed again meanwhile", async () => {
    fetchMock
      .mockImplementationOnce(() => analyzeResponse(403, challenged))
      .mockImplementationOnce(() =>
        analyzeResponse(202, { status: "queued", jobId: JOB, owner: "acme", repo: "shop" }),
      );
    render(<NotAnalyzed owner="acme" repo="shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await widgetOptions();
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ url: "acme/shop" });
  });

  it("says so in place when the bot check fails", async () => {
    fetchMock.mockImplementationOnce(() => analyzeResponse(403, challenged));
    render(<NotAnalyzed owner="acme" repo="shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const options = await widgetOptions();
    act(() => void options["error-callback"]());
    expect(screen.getByRole("alert").textContent).toBe(CHECK_FAILED_MESSAGE);
    expect(screen.queryByTestId("bot-check")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
