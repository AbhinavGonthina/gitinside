import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoForm } from "./RepoForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

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

  it("clears the error as soon as the visitor edits the field", () => {
    render(<RepoForm />);
    submit();
    fireEvent.change(field(), { target: { value: "a" } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText(/^Public repos, no sign-in\./)).toBeTruthy();
  });
});
