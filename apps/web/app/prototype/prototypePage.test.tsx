import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import shopDemo from "../../../../fixtures/shop-demo/expected.json";
import { findPrototypeRepo } from "../../lib/prototype";
import { GALLERY_CROP } from "../../lib/prototypeImage";
import { HostSwap } from "./HostSwap";
import PrototypePage, { metadata } from "./page";
import { PrototypeDiagram } from "./PrototypeDiagram";
import { PrototypeHero } from "./PrototypeHero";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Next's `Link` routes on the client in a browser (it prevents the click's default), but does
// nothing without an app router; this stand-in does what it does in a browser.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href} onClick={(event) => event.preventDefault()}>
      {children}
    </a>
  ),
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

/**
 * Whether a click on `link` reaches the window with its default left alone: a document navigation
 * (cross-document View Transitions run on those), not a client-side route change. The window's
 * listener then prevents it, since jsdom can't navigate.
 */
function clickIsLeftToBrowser(link: HTMLElement): boolean {
  let left = false;
  const listener = (event: Event) => {
    left = !event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener("click", listener);
  try {
    fireEvent.click(link);
  } finally {
    window.removeEventListener("click", listener);
  }
  return left;
}

describe("the prototype page (M10.3a)", () => {
  it("is never indexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("is the redesigned landing with no `repo` (M10.3e1): the pitch beside the live hero, the swap line, and the five repos at its foot", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container } = render(await page({}));
    const hero = container.querySelector(".landing__hero") as HTMLElement;
    expect(within(hero).getByRole("heading", { level: 1 }).textContent).toBe(
      "Git inside your repo.",
    );
    expect(within(hero).getByRole("textbox", { name: "GitHub repo URL" })).toBeTruthy();
    // "See how it works" opens the tour's pin with its tour started; the hero loads the hero pin's graph.
    expect(within(hero).getByRole("link", { name: "See how it works" }).getAttribute("href")).toBe(
      "/prototype?repo=Mintplex-Labs/anything-llm&tour",
    );
    expect(within(hero).getByRole("status").textContent).toBe("Loading getmaxun/maxun");
    expect(
      within(hero).getByRole("link", { name: "Open the full diagram" }).getAttribute("href"),
    ).toBe("/prototype?repo=getmaxun/maxun");
    expect(within(hero).getByRole("link", { name: "Sign in for private repos" })).toBeTruthy();
    // The swap line: GitHub's host and GitInside's, the path once.
    const swap = container.querySelector(".swap") as HTMLElement;
    expect(swap.textContent).toBe(
      "Or swap the host:github.comgitinside.abhinavgonthina.dev/getmaxun/maxun",
    );
    const review = screen.getByRole("region", { name: "Design review: the five repos" });
    expect(
      within(review)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/prototype?repo=krishnaacharyaa/wanderlust",
      "/prototype?repo=documenso/documenso",
      "/prototype?repo=Mintplex-Labs/anything-llm",
      "/prototype?repo=shadcn-ui/taxonomy",
      "/prototype?repo=getmaxun/maxun",
    ]);
  });

  it("shows each demo pin as a crop of its image, linking its prototype page, then how it works in three steps (M10.3e2a)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container } = render(await page({}));
    const gallery = screen.getByRole("region", { name: "See it on real repos" });
    const links = within(gallery)
      .getAllByRole("link")
      .filter((a) => a.classList.contains("demo__link"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/prototype?repo=Mintplex-Labs/anything-llm",
      "/prototype?repo=shadcn-ui/taxonomy",
      "/prototype?repo=getmaxun/maxun",
    ]);
    // One image per theme, at the crop's own size (100%).
    const images = [...(links[2] as HTMLElement).querySelectorAll("img")];
    expect(images.map((img) => [img.dataset.themeOnly, img.getAttribute("src")])).toEqual([
      ["dark", "/api/prototype/diagram/getmaxun/maxun?theme=dark"],
      ["light", "/api/prototype/diagram/getmaxun/maxun?theme=light"],
    ]);
    expect(images[0]?.getAttribute("width")).toBe(String(GALLERY_CROP.width));
    expect(images[0]?.getAttribute("height")).toBe(String(GALLERY_CROP.height));
    // The shipped "What you get" list gives way to the three steps.
    expect(container.querySelector(".landing__promises")).toBeNull();
    const how = screen.getByRole("region", { name: "How it works" });
    expect(
      within(how)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Parse", "Link", "Draw"]);
    expect(how.querySelector("ol")?.children).toHaveLength(3);
  });

  it("links its prototype pages with full navigations, so the browser's page transition runs (M10.3e2b)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(await page({}));
    const links = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("/prototype"));
    // The hero's two, the swap line, three gallery cards, the five repos.
    expect(links).toHaveLength(11);
    for (const link of links) expect(clickIsLeftToBrowser(link), link.textContent ?? "").toBe(true);
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
      tour: false,
    });
  });

  it("starts the guided tour with `&tour`, its last card offering the repo field (M10.3f2a)", async () => {
    expect((await page({ repo: "Mintplex-Labs/anything-llm", tour: "" })).props.tour).toBe(true);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(shopDemo)));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: { width: 900, height: 600 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    const { container } = render(
      <PrototypeDiagram
        owner="fixtures"
        repo="shop-demo"
        sha={"a".repeat(40)}
        graphUrl="/api/prototype/graph/fixtures/shop-demo"
        tour
      />,
    );
    const card = await waitFor(
      () => {
        const found = container.querySelector<HTMLElement>(".gi-tour");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      },
      { timeout: 25_000 },
    );
    expect(card.textContent).toContain("Tour · 1 of");
    // Through to the Done card, by its Next / Finish button.
    for (let i = 0; i < 6 && !card.textContent?.includes("Your turn"); i++) {
      const next = within(card)
        .getAllByRole("button")
        .find((b) => /^(Next|Finish)/.test(b.textContent ?? ""));
      if (next) act(() => fireEvent.click(next));
    }
    await waitFor(() => expect(card.textContent).toContain("Your turn"));
    expect(within(card).getByRole("textbox", { name: "GitHub repo URL" })).toBeTruthy();
  }, 30_000);

  it("puts the theme switch, in the cookie's theme, and sign-in in its one bar (M10.3c1)", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container } = render(await page({ repo: "getmaxun/maxun" }));
    const bar = container.querySelector<HTMLElement>(".gi-topbar");
    expect(bar?.dataset.variant).toBe("page");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).closest(".gi-topbar")).toBe(bar);
  });
});

describe("the prototype landing's hero (M10.3e1)", () => {
  it("draws the hero pin in the explorer's hero mode, its link following the trace it plays", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(shopDemo)));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe() {
          this.report(
            [{ contentRect: { width: 720, height: 480 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    const { container } = render(<PrototypeHero repo={maxun} />);
    const open = screen.getByRole("link", { name: "Open the full diagram" });
    expect(open.getAttribute("href")).toBe("/prototype?repo=getmaxun/maxun");
    await waitFor(() => expect(container.querySelector(".gi-explorer[data-hero]")).not.toBeNull());
    expect(container.querySelector(".gi-topbar, .gi-inspector")).toBeNull();
    expect(container.querySelector(".hero__frame")?.hasAttribute("data-loading")).toBe(false);
    // Once the trace starts, the link opens the full diagram on it.
    await waitFor(() => expect(open.getAttribute("href")).toMatch(/&(.+&)?trace=page/), {
      timeout: 25_000,
    });
  }, 30_000);

  it("says so in the frame when the graph can't be loaded", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 502 }));
    const maxun = findPrototypeRepo("getmaxun", "maxun");
    if (!maxun) throw new Error("no maxun");
    render(<PrototypeHero repo={maxun} />);
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(screen.getByRole("link", { name: "Open the full diagram" })).toBeTruthy();
  });
});

describe("the URL swap line (M10.3e1)", () => {
  it("swaps GitHub's host for GitInside's once, when it comes into view", () => {
    const observers: { report: IntersectionObserverCallback; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        entry: { report: IntersectionObserverCallback; disconnected: boolean };
        constructor(report: IntersectionObserverCallback) {
          this.entry = { report, disconnected: false };
          observers.push(this.entry);
        }
        observe() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
    const { container } = render(
      <HostSwap path="/getmaxun/maxun" host="gitinside.example" href="/prototype?repo=x/y" />,
    );
    const url = container.querySelector(".swap__url") as HTMLElement;
    const report = (isIntersecting: boolean) =>
      act(() =>
        observers[0]?.report(
          [{ isIntersecting } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    expect(url.hasAttribute("data-swapped")).toBe(false);
    report(false);
    expect(url.hasAttribute("data-swapped")).toBe(false);
    report(true);
    expect(url.hasAttribute("data-swapped")).toBe(true);
    expect(observers[0]?.disconnected).toBe(true);
    // Screen readers read where the link goes: GitInside's host, not GitHub's.
    expect(container.querySelector('[data-host="github"]')?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.getByRole("link").textContent).toContain("gitinside.example/getmaxun/maxun");
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
    // The mark goes back to the prototype's landing (M10.3e1).
    expect(screen.getByRole("link", { name: "GitInside home" }).getAttribute("href")).toBe(
      "/prototype",
    );
    const chip = container.querySelector<HTMLAnchorElement>(".gi-commit");
    expect(chip?.href).toBe(`https://github.com/getmaxun/maxun/commit/${sha}`);
    expect(chip?.title).toBe(`Commit ${sha}, pinned for the design review`);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("Loading the diagram")).toBeTruthy();
  });
});
