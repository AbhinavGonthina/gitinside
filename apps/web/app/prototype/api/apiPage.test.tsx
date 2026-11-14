import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_QUERY, type ApiQuery } from "../../../lib/prototypeApiMap";
import { apiMapGraph } from "../../../lib/prototypeApiMap.testkit";
import type { PrototypeRepo } from "../../../lib/prototypeLinks";
import { PrototypeDiagram } from "../PrototypeDiagram";
import PrototypeApiPage, { metadata } from "./page";
import { PrototypeApiMap } from "./PrototypeApiMap";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("../../../lib/currentUser", () => ({
  currentSignIn: async () => ({ available: true }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const repo: PrototypeRepo = { owner: "fixtures", name: "shop-demo", sha: "a".repeat(40) };

function draw(initial: Partial<ApiQuery> = {}) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(apiMapGraph())));
  return render(
    <PrototypeApiMap
      repo={repo}
      graphUrl="/api/prototype/graph/fixtures/shop-demo"
      initial={{ ...DEFAULT_API_QUERY, ...initial }}
    />,
  );
}

/** The table's route rows as "METHOD path · callers". */
function rows(): string[] {
  return [...document.querySelectorAll(".api-row > tr:first-child")].map((tr) => {
    const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "");
    return `${cells[0]} ${cells[1]} · ${cells[3]}`;
  });
}

const loaded = () => screen.findByText(/^3 routes · /);

describe("the prototype's API map page (M10.3f3)", () => {
  it("is never indexed, and is a 404 for any repo but the prototype's", async () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const page = (query: Record<string, string>) =>
      PrototypeApiPage({ searchParams: Promise.resolve(query) });
    await expect(page({ repo: "vercel/next.js" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page({})).rejects.toThrow("NEXT_NOT_FOUND");
    const element = await page({ repo: "getmaxun/maxun", tab: "dead", q: "runs" });
    expect(element.props).toMatchObject({
      graphUrl: "/api/prototype/graph/getmaxun/maxun",
      initial: { tab: "dead", q: "runs", service: "", method: "" },
    });
  });

  it("draws the one bar with `Diagram | API map`, and the table's head over a moving line while it loads", () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { container } = render(
      <PrototypeApiMap repo={repo} graphUrl="/x" initial={DEFAULT_API_QUERY} />,
    );
    expect(container.querySelector("main")?.hasAttribute("data-own-header")).toBe(true);
    const bar = container.querySelector(".gi-topbar") as HTMLElement;
    const views = within(bar).getByRole("navigation", { name: "Views" });
    expect(
      within(views)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")]),
    ).toEqual([
      ["Diagram", "/prototype?repo=fixtures/shop-demo", null],
      ["API map", "/prototype/api?repo=fixtures/shop-demo", "page"],
    ]);
    expect(within(bar).getByRole("searchbox", { name: "Filter routes" })).toBeTruthy();
    expect([...container.querySelectorAll(".api-table th")].map((th) => th.textContent)).toEqual([
      "Method",
      "Path",
      "Service",
      "Callers",
      "Diagram",
    ]);
    // No grey placeholder rows: the head, the line, and words for screen readers.
    expect(container.querySelectorAll(".api-row")).toHaveLength(0);
    expect(container.querySelector(".api-table__line")).not.toBeNull();
    expect(screen.getByText("Loading the routes").getAttribute("role")).toBe("status");
  });

  it("lists every route by path with its callers, each linking into the diagram with it selected", async () => {
    draw();
    await loaded();
    expect(screen.getByText(/^3 routes · /).textContent).toBe(
      "3 routes · 1 with no caller in the repo · 1 broken call",
    );
    expect(rows()).toEqual([
      "GET /api/orders · 3 · 2 exact, 1 heuristic",
      "POST /api/orders · 1 · heuristic",
      "DELETE /api/orders/:id · No caller in the repo",
    ]);
    const link = screen.getByRole("link", { name: "Open DELETE /api/orders/:id in the diagram" });
    expect(link.getAttribute("href")).toBe(
      "/prototype?repo=fixtures/shop-demo&sel=route:api/DELETE%20/api/orders/:id",
    );
    // A route nobody calls has nothing to open.
    expect(screen.queryByRole("button", { name: "/api/orders/:id" })).toBeNull();
  });

  it("opens a row to its callers, each a link to its line on GitHub with its confidence", async () => {
    draw();
    await loaded();
    const toggle = screen.getAllByRole("button", { name: "/api/orders" })[0] as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "Callers of GET /api/orders" });
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => [li.textContent, li.querySelector("a")?.getAttribute("href")]),
    ).toEqual([
      [
        "apps/web/lib/cms.ts:7latestPosts@shop/webexact",
        `https://github.com/fixtures/shop-demo/blob/${repo.sha}/apps/web/lib/cms.ts#L7`,
      ],
      [
        "apps/web/lib/cms.ts:9latestPosts@shop/webexact",
        `https://github.com/fixtures/shop-demo/blob/${repo.sha}/apps/web/lib/cms.ts#L9`,
      ],
      [
        "apps/web/lib/orders.ts:13listOrders@shop/webheuristic",
        `https://github.com/fixtures/shop-demo/blob/${repo.sha}/apps/web/lib/orders.ts#L13`,
      ],
    ]);
    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Callers of GET /api/orders" })).toBeNull();
  });

  it("switches tabs by click and arrow keys, keeping the tab, search, and filters in the URL", async () => {
    draw();
    await loaded();
    const tab = (name: RegExp) => screen.getByRole("tab", { name });
    expect(
      screen.getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-selected")]),
    ).toEqual([
      ["All3", "true"],
      ["No caller1", "false"],
      ["Broken calls1", "false"],
    ]);
    fireEvent.click(tab(/^No caller/));
    expect(rows()).toEqual(["DELETE /api/orders/:id · No caller in the repo"]);
    expect(window.location.search).toBe("?repo=fixtures/shop-demo&tab=dead");
    act(() => tab(/^No caller/).focus());
    fireEvent.keyDown(tab(/^No caller/), { key: "ArrowRight" });
    expect(tab(/^Broken calls/).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab(/^Broken calls/));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      tab(/^Broken calls/).id,
    );
    fireEvent.keyDown(tab(/^Broken calls/), { key: "ArrowRight" });
    expect(tab(/^All/).getAttribute("aria-selected")).toBe("true");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter routes" }), {
      target: { value: "post" },
    });
    expect(rows()).toEqual(["POST /api/orders · 1 · heuristic"]);
    // The counts follow the search.
    expect(tab(/^All/).textContent).toBe("All1");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter routes" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Method" }), {
      target: { value: "DELETE" },
    });
    expect(rows()).toEqual(["DELETE /api/orders/:id · No caller in the repo"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Service" }), {
      target: { value: "service:web/" },
    });
    expect(rows()).toEqual([]);
    expect(screen.getByText("No routes match.")).toBeTruthy();
    expect(window.location.search).toBe(
      "?repo=fixtures/shop-demo&service=service:web/&method=DELETE",
    );
  });

  it("opens on the URL's tab and filters", async () => {
    draw({ tab: "all", method: "GET" });
    await loaded();
    expect(rows()).toEqual(["GET /api/orders · 3 · 2 exact, 1 heuristic"]);
    expect((screen.getByRole("combobox", { name: "Method" }) as HTMLSelectElement).value).toBe(
      "GET",
    );
  });

  it("lists broken calls as the analyzer read them, with the requests it couldn't read apart and uncounted", async () => {
    draw({ tab: "broken" });
    await loaded();
    const [broken] = screen.getAllByRole("table");
    const cells = (table: HTMLElement) =>
      [...table.querySelectorAll("tbody tr")].map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent),
      );
    expect(cells(broken as HTMLElement)).toEqual([
      [
        "GET",
        "{env:CMS_URL}/posts",
        "@shop/web",
        "apps/web/lib/cms.ts:3",
        "The env var CMS_URL isn't named like an API base (*_API_URL, *_API_PATH, …)",
      ],
    ]);
    expect(screen.getByText(/^Not counted as broken:/).textContent).toBe(
      "Not counted as broken: 1 request whose URL GitInside couldn’t read, so it can’t say which route it reaches.",
    );
    const show = screen.getByRole("button", { name: "Show them" });
    fireEvent.click(show);
    expect(show.getAttribute("aria-expanded")).toBe("true");
    expect(cells(screen.getByRole("table", { name: "Unread requests" }))).toEqual([
      [
        "GET",
        "base",
        "@shop/web",
        "apps/web/lib/orders.ts:20",
        "The URL starts with a value only known at runtime",
      ],
    ]);
    // The "no caller" caveat is about routes, so it's not under requests.
    expect(screen.queryByText(/outside clients/)).toBeNull();
  });

  it("says so when the graph can't be loaded, with Try again", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 502 }));
    render(<PrototypeApiMap repo={repo} graphUrl="/x" initial={DEFAULT_API_QUERY} />);
    expect((await screen.findByRole("alert")).textContent).toContain("The diagram didn't load");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("the prototype diagram's bar (M10.3f3)", () => {
  it("has the same `Diagram | API map` switch, Diagram current", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    render(<PrototypeDiagram owner="getmaxun" repo="maxun" sha={"b".repeat(40)} graphUrl="/x" />);
    const views = screen.getByRole("navigation", { name: "Views" });
    await waitFor(() =>
      expect(
        within(views)
          .getAllByRole("link")
          .map((a) => [a.getAttribute("href"), a.getAttribute("aria-current")]),
      ).toEqual([
        ["/prototype?repo=getmaxun/maxun", "page"],
        ["/prototype/api?repo=getmaxun/maxun", null],
      ]),
    );
  });

  it("opens the way to a route a link selects, as Diagram ↗ does, so it arrives as its own box", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(apiMapGraph())));
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
    const route = "route:api/DELETE /api/orders/:id";
    window.history.replaceState(
      null,
      "",
      "/prototype?repo=fixtures/shop-demo&sel=route:api/DELETE%20/api/orders/:id",
    );
    const { container } = render(
      <PrototypeDiagram owner="fixtures" repo="shop-demo" sha={repo.sha} graphUrl="/x" />,
    );
    const box = await waitFor(
      () => {
        const found = container.querySelector(`[data-node-id="${route}"] > .gi-node`);
        expect(found).not.toBeNull();
        return found as HTMLElement;
      },
      { timeout: 25_000 },
    );
    expect(box.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[data-node-id="service:api/"]')?.hasAttribute("data-open"),
    ).toBe(true);
  }, 30_000);
});
