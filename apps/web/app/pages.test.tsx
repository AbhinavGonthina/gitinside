import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RepoPage, { generateMetadata } from "./[owner]/[repo]/page";
import NotFound from "./not-found";
import Home from "./page";
import { SiteHeader } from "./SiteHeader";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(cleanup);

const params = (owner: string, repo: string) => Promise.resolve({ owner, repo });

describe("landing page", () => {
  it("leads with the slogan, then the field (UX.md Website flows)", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Git inside your repo.");
    expect(screen.getByRole("textbox", { name: "GitHub repo URL" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeTruthy();
  });

  it("lists what you get, each with a decorative glyph", () => {
    render(<Home />);
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
  it("links home and offers the theme switch", () => {
    render(<SiteHeader theme="dark" />);
    expect(screen.getByRole("link", { name: "GitInside" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
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

describe("not found", () => {
  it("explains where repo pages live and links home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("There's no page here.");
    expect(screen.getByRole("link", { name: "Analyze a repo" }).getAttribute("href")).toBe("/");
  });
});
