import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrototypePage, { metadata } from "./page";
import { PrototypeDiagram } from "./PrototypeDiagram";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "gi-theme" ? { value: "light" } : undefined),
  }),
}));

vi.mock("../../lib/currentUser", () => ({
  currentSignIn: async () => ({ available: true }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (query: Record<string, string | string[]>) =>
  PrototypePage({ searchParams: Promise.resolve(query) });

describe("the prototype page (M10.3a)", () => {
  it("is never indexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("lists the five repos with no `repo`, each linking its prototype diagram", async () => {
    render(await page({}));
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/prototype?repo=krishnaacharyaa/wanderlust",
      "/prototype?repo=documenso/documenso",
      "/prototype?repo=Mintplex-Labs/anything-llm",
      "/prototype?repo=shadcn-ui/taxonomy",
      "/prototype?repo=getmaxun/maxun",
    ]);
  });

  it("is a 404 for any other repo, and for a repeated `repo`", async () => {
    await expect(page({ repo: "vercel/next.js" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page({ repo: ["getmaxun/maxun", "x/y"] })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws one of the five from the proxy", async () => {
    const element = await page({ repo: "getmaxun/maxun" });
    expect(element.props).toMatchObject({
      owner: "getmaxun",
      repo: "maxun",
      graphUrl: "/api/prototype/graph/getmaxun/maxun",
    });
  });

  it("puts the theme switch, in the cookie's theme, and sign-in in its one bar (M10.3c1)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container } = render(await page({ repo: "getmaxun/maxun" }));
    const bar = container.querySelector<HTMLElement>(".gi-topbar");
    expect(bar?.dataset.variant).toBe("page");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).closest(".gi-topbar")).toBe(bar);
  });
});

describe("PrototypeDiagram's one bar (M10.3c1)", () => {
  it("draws the page's only bar while the graph loads, telling the site header to stay out", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const { container } = render(
      <PrototypeDiagram
        owner="getmaxun"
        repo="maxun"
        sha={sha}
        graphUrl="/api/prototype/graph/getmaxun/maxun"
        barEnd={<button type="button">Sign in</button>}
      />,
    );
    expect(container.querySelector("main")?.hasAttribute("data-own-header")).toBe(true);
    expect(container.querySelectorAll(".gi-topbar")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "GitInside home" }).getAttribute("href")).toBe("/");
    const chip = container.querySelector<HTMLAnchorElement>(".gi-commit");
    expect(chip?.href).toBe(`https://github.com/getmaxun/maxun/commit/${sha}`);
    expect(chip?.title).toBe(`Commit ${sha}, pinned for the design review`);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("Loading the diagram")).toBeTruthy();
  });
});
