import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { NBSP } from "../lib/limits";
import type { TurnstileOptions } from "../lib/turnstile";
import { CHECK_FAILED_MESSAGE, CHECK_TIMED_OUT_MESSAGE, LOAD_FAILED_MESSAGE } from "./BotCheck";
import { RepoForm } from "./RepoForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// Cloudflare's script never loads in tests: a fake `window.turnstile` stands in.
const turnstile = {
  render: vi.fn<(container: HTMLElement, options: TurnstileOptions) => string>(),
  remove: vi.fn<(id: string) => void>(),
};
const { loadTurnstile } = vi.hoisted(() => ({ loadTurnstile: vi.fn() }));
vi.mock("../lib/turnstile", async (original) => ({
  ...(await original<typeof import("../lib/turnstile")>()),
  loadTurnstile,
}));
beforeEach(() => {
  turnstile.render.mockReset().mockReturnValue("widget-1");
  turnstile.remove.mockReset();
  loadTurnstile.mockReset().mockResolvedValue(turnstile);
});

const JOB = `analyze-${"b".repeat(32)}`;
const SHA = "c".repeat(40);
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function field() {
  return screen.getByRole("textbox", { name: "GitHub repo URL" });
}

function hint() {
  return document.getElementById(field().getAttribute("aria-describedby")!)!;
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
}

describe("RepoForm", () => {
  it("has a labeled field, the paste prompt, and the support hint", () => {
    render(<RepoForm />);
    expect(field()).toHaveProperty("placeholder", "Paste a GitHub repo URL");
    expect(hint().textContent).toMatch(/^Public repos, no sign-in\./);
    // The supported size is said before anyone pastes a repo over it (M5.16c).
    expect(hint().textContent).toContain(
      `up to 20,000 source files and 50${NBSP}MB of source code`,
    );
    expect(hint().getAttribute("aria-live")).toBe("polite");
  });

  it("starts an analysis and opens the progress page for a queued commit", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { status: "queued", jobId: JOB, owner: "acme", repo: "shop", sha: SHA },
        { status: 202 },
      ),
    );
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: " https://github.com/acme/shop.git " } });
    submit();
    expect(hint().textContent).toBe("Checking the latest commit on GitHub…");
    expect(field().closest("form")?.getAttribute("aria-busy")).toBe("true");
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: " https://github.com/acme/shop.git ",
    });
  });

  it("opens the repo page at once for an analyzed commit; Enter submits too", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ status: "done", owner: "acme", repo: "shop", sha: SHA }),
    );
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "acme/shop" } });
    fireEvent.submit(field().closest("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme/shop"));
  });

  it("ignores a second submit while the first is in flight", async () => {
    let answer: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "acme/shop" } });
    submit();
    submit();
    answer(Response.json({ status: "done", owner: "acme", repo: "shop", sha: SHA }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says the server's refusal in place and keeps focus in the field", async () => {
    const message = "Analysis is temporarily unavailable. Already-analyzed repos still work.";
    fetchMock.mockResolvedValue(Response.json({ error: "UNAVAILABLE", message }, { status: 503 }));
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "acme/shop" } });
    submit();
    await waitFor(() => expect(hint().textContent).toBe(message));
    expect(hint().hasAttribute("data-error")).toBe(true);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    expect(field().closest("form")?.hasAttribute("aria-busy")).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("says what's wrong with a bad URL without asking the server", () => {
    render(<RepoForm />);
    fireEvent.change(field(), { target: { value: "https://gitlab.com/acme/shop" } });
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    expect(hint().textContent).toBe(
      "That isn't a GitHub repo URL. Try https://github.com/owner/repo.",
    );
    expect(hint().hasAttribute("data-error")).toBe(true);
  });

  it("asks for a URL when submitted empty", () => {
    render(<RepoForm />);
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Paste a GitHub repo URL first.")).toBeTruthy();
  });

  describe("the bot check (ADR-0157)", () => {
    const message = "GitInside is busier than usual, so we're checking that you're a person.";
    const required = () =>
      Response.json({ error: "CHALLENGE_REQUIRED", message, siteKey: "0x4AAA" }, { status: 403 });

    it("runs the widget when asked, then sends the same URL again with its token", async () => {
      fetchMock
        .mockResolvedValueOnce(required())
        .mockResolvedValueOnce(
          Response.json(
            { status: "queued", jobId: JOB, owner: "acme", repo: "shop", sha: SHA },
            { status: 202 },
          ),
        );
      render(<RepoForm />);
      fireEvent.change(field(), { target: { value: "acme/shop" } });
      submit();
      await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
      // Said calmly, not as an error, and not loaded before the server asked.
      expect(hint().textContent).toBe(message);
      expect(hint().hasAttribute("data-error")).toBe(false);
      expect(loadTurnstile).toHaveBeenCalledTimes(1);
      const [container, options] = turnstile.render.mock.calls[0]!;
      expect(container).toBe(screen.getByTestId("bot-check"));
      expect(options).toMatchObject({
        sitekey: "0x4AAA",
        action: "analyze",
        theme: "dark",
        appearance: "interaction-only",
      });
      // The visitor edits the field while the check runs: what was asked for continues.
      fireEvent.change(field(), { target: { value: "acme/other" } });
      act(() => options.callback("tok.en"));
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/acme/shop/jobs/${JOB}`));
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        url: "acme/shop",
        turnstileToken: "tok.en",
      });
      expect(turnstile.remove).toHaveBeenCalledWith("widget-1");
    });

    it("uses the light theme on a light page", async () => {
      document.documentElement.dataset.theme = "light";
      onTestFinished(() => {
        delete document.documentElement.dataset.theme;
      });
      fetchMock.mockResolvedValueOnce(required());
      render(<RepoForm />);
      fireEvent.change(field(), { target: { value: "acme/shop" } });
      submit();
      await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
      expect(turnstile.render.mock.calls[0]![1].theme).toBe("light");
    });

    it("says so when the widget fails, times out, or can't load", async () => {
      const cases: [string, () => void][] = [
        [CHECK_FAILED_MESSAGE, () => turnstile.render.mock.calls.at(-1)![1]["error-callback"]()],
        [
          CHECK_TIMED_OUT_MESSAGE,
          () => turnstile.render.mock.calls.at(-1)![1]["timeout-callback"](),
        ],
      ];
      for (const [expected, fire] of cases) {
        fetchMock.mockResolvedValueOnce(required());
        render(<RepoForm />);
        fireEvent.change(field(), { target: { value: "acme/shop" } });
        submit();
        await waitFor(() => expect(screen.queryByTestId("bot-check")).not.toBeNull());
        await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
        act(fire);
        expect(hint().textContent).toBe(expected);
        expect(hint().hasAttribute("data-error")).toBe(true);
        expect(document.activeElement).toBe(field());
        expect(screen.queryByTestId("bot-check")).toBeNull();
        cleanup();
      }

      loadTurnstile.mockRejectedValueOnce(new Error("blocked"));
      fetchMock.mockResolvedValueOnce(required());
      render(<RepoForm />);
      fireEvent.change(field(), { target: { value: "acme/shop" } });
      submit();
      await waitFor(() => expect(hint().textContent).toBe(LOAD_FAILED_MESSAGE));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it("clears the error as soon as the visitor edits the field", () => {
    render(<RepoForm />);
    submit();
    fireEvent.change(field(), { target: { value: "a" } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText(/^Public repos, no sign-in\./)).toBeTruthy();
  });
});
