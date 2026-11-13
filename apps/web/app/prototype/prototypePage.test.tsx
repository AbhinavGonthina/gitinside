import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrototypePage, { metadata } from "./page";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(cleanup);

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
});
