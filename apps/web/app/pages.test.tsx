import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProgressPage, {
  generateMetadata as progressMetadata,
} from "./[owner]/[repo]/jobs/[job]/page";
import RepoPage, { generateMetadata } from "./[owner]/[repo]/page";
import { SIGN_IN_NOTES } from "../lib/messages";
import { Landing } from "./Landing";
import NotFound from "./not-found";
import Home from "./page";
import { SiteHeader } from "./SiteHeader";

const router = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The repo page reads Vercel's OIDC token from its request (ADR-0142); none here.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

afterEach(cleanup);

const params = (owner: string, repo: string) => Promise.resolve({ owner, repo });

const home = async (query: Record<string, string | string[]> = {}) =>
  render(await Home({ searchParams: Promise.resolve(query) }));

describe("landing page", () => {
  it("leads with the slogan, then the field (UX.md Website flows)", async () => {
    await home();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Git inside your repo.");
    expect(screen.getByRole("textbox", { name: "GitHub repo URL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });

  it("offers nothing about sign-in while it isn't set up on the server", async () => {
    await home({ signin: "failed" }); // the note still explains where they landed
    expect(screen.queryByRole("link", { name: "Sign in for private repos" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(SIGN_IN_NOTES["failed"]);
  });

  it("offers signing in for private repos while signed out, and not once signed in", () => {
    const { unmount } = render(<Landing signIn={{ available: true }} />);
    expect(
      screen.getByRole("link", { name: "Sign in for private repos" }).getAttribute("href"),
    ).toBe("/api/auth/github");
    unmount();
    render(<Landing signIn={{ available: true, login: "octo" }} />);
    expect(screen.queryByRole("link", { name: "Sign in for private repos" })).toBeNull();
  });

  it.each([
    [{ signin: "cancelled" }, "Sign-in was cancelled on GitHub. Nothing changed."],
    [{ signin: "expired" }, "Sign-in took too long, so it was stopped. Try again."],
    [{ signin: "failed" }, "Sign-in didn't work. Try again."],
    [
      { signin: "unavailable" },
      "Sign-in isn't available right now. Public repos still work without it.",
    ],
    [{ signout: "failed" }, "We couldn't sign you out. Try again."],
  ])("explains %j where a failed sign-in lands", async (query, note) => {
    await home(query);
    expect(screen.getByRole("status").textContent).toBe(note);
  });

  it.each([{}, { signin: "constructor" }, { signin: "<b>x</b>" }, { signin: ["failed", "x"] }])(
    "says nothing for %j, never echoing it",
    async (query) => {
      await home(query);
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("lists what you get, each with a decorative glyph", async () => {
    await home();
    const list = screen.getByRole("list", { name: "What you get" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByRole("heading").textContent)).toEqual([
      "Parsed, never guessed",
      "Services down to functions",
      "Follow a request",
      "Gaps stay visible",
    ]);
    for (const li of items) {
      expect(li.querySelector("[aria-hidden] svg.gi-glyph")).not.toBeNull();
    }
  });
});

describe("site header", () => {
  it("links home and offers the theme switch, and no sign-in while it isn't set up", () => {
    render(<SiteHeader theme="dark" signIn={{ available: false }} />);
    expect(screen.getByRole("link", { name: "GitInside" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("offers Sign in while signed out", () => {
    render(<SiteHeader theme="dark" signIn={{ available: true }} />);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/api/auth/github",
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("names the signed-in login and signs out with a same-origin form POST", () => {
    render(<SiteHeader theme="light" signIn={{ available: true, login: "octo" }} />);
    expect(screen.getByText("octo")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    const button = screen.getByRole("button", { name: "Sign out" });
    expect(button.getAttribute("type")).toBe("submit");
    const form = button.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/auth/signout");
  });
});

describe("repo page", () => {
  it("names the repo and says plainly that analysis isn't available yet", async () => {
    render(await RepoPage({ params: params("acme", "shop") }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme / shop");
    expect(
      screen.getByText("Analysis is temporarily unavailable. Already-analyzed repos still work."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(
      "https://github.com/acme/shop",
    );
    expect(screen.getByRole("link", { name: "Analyze another repo" }).getAttribute("href")).toBe(
      "/",
    );
  });

  it.each([
    ["settings", "profile"],
    ["acme", ".."],
    ["<script>", "x"],
  ])("is a 404 for %j / %j, never echoing it", async (owner, repo) => {
    await expect(RepoPage({ params: params(owner, repo) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("titles the tab with the repo, and adds nothing for a bad name", async () => {
    expect(await generateMetadata({ params: params("acme", "shop") })).toEqual({
      title: "acme/shop",
    });
    expect(await generateMetadata({ params: params("-x", "shop") })).toEqual({});
  });
});

describe("progress page", () => {
  const JOB = `analyze-${"e".repeat(32)}`;
  const jobParams = (owner: string, repo: string, job: string) =>
    Promise.resolve({ owner, repo, job });

  it("renders the live progress for a valid repo and job", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      },
    );
    render(await ProgressPage({ params: jobParams("acme", "shop", JOB) }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme / shop");
    expect(screen.getByRole("progressbar", { name: "Analysis progress" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it.each([
    ["settings", "profile", JOB],
    ["acme", "shop", "analyze-123"],
    ["acme", "shop", `diff-${"e".repeat(32)}`],
  ])("is a 404 for %j / %j / %j", async (owner, repo, job) => {
    await expect(ProgressPage({ params: jobParams(owner, repo, job) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("titles the tab and keeps the page out of search results", async () => {
    expect(await progressMetadata({ params: jobParams("acme", "shop", JOB) })).toEqual({
      title: "Analyzing acme/shop",
      robots: { index: false },
    });
    expect(await progressMetadata({ params: jobParams("acme", "shop", "x") })).toEqual({});
  });
});

describe("not found", () => {
  it("explains where repo pages live and links home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("There's no page here.");
    expect(screen.getByRole("link", { name: "Analyze a repo" }).getAttribute("href")).toBe("/");
  });
});
