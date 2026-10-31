import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SHA } from "./fixture";

// The repo page on the seeded server (M4b.14a): a permalink to the analysis database.ts
// seeded, drawing fixtures/shop-demo in the explorer as a visitor would use it. The browser's
// two outside reads are answered here: `/api/graph` (object storage in production) with the
// analyzer's golden output, stamped with the commit as the worker's graphs are, and
// raw.githubusercontent.com with the fixture's files. Everything else (the CSP, hydration,
// the layout Web Worker, ELK, Shiki, deep links) is the production build's own.

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/shop-demo");
const graph = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
  repo: Record<string, string>;
  nodes: { id: string; source?: { file: string; line: number } }[];
};
const PERMALINK = `/fixtures/shop-demo/${E2E_SHA}`;
const WEB = "service:web/";
const CHECKOUT = "page:web//checkout";

/** Fails the test on any page error, console error or warning, or CSP violation. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  return errors;
}

/** Answers the graph and the code previews' file reads; returns the files read. */
async function serveRepo(page: Page): Promise<string[]> {
  const files: string[] = [];
  await page.route(`**/api/graph/fixtures/shop-demo/${E2E_SHA}`, (route) =>
    route.fulfill({ json: { ...graph, repo: { ...graph.repo, sha: E2E_SHA } } }),
  );
  const raw = `https://raw.githubusercontent.com/fixtures/shop-demo/${E2E_SHA}/`;
  await page.route(`${raw}**`, (route) => {
    const path = route.request().url().slice(raw.length);
    files.push(path);
    return route.fulfill({
      body: readFileSync(join(FIXTURE, path), "utf8"),
      headers: { "access-control-allow-origin": "*", "content-type": "text/plain" },
    });
  });
  return files;
}

/** Waits until the canvas has laid out and drawn the current level. */
async function settle(page: Page) {
  await expect(page.locator(".gi-drill")).toHaveAttribute("data-layout", "done", {
    timeout: 30_000,
  });
  await expect(page.locator(".gi-drill")).not.toHaveAttribute("aria-busy", /.*/);
}

/** A box on the canvas by node ID (not one folding away). */
const box = (page: Page, id: string) =>
  page.locator(`.gi-drill__node:not([data-leaving])[data-node-id="${id}"] > .gi-node`);

/** The inspector's title. */
const heading = (page: Page) => page.getByRole("complementary").getByRole("heading", { level: 2 });

/** Opens the permalink with the first-visit tips already put away ("Don't show again"). */
async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await page.goto(PERMALINK);
  await settle(page);
}

test("the permalink draws the diagram, laid out in a Web Worker under the CSP", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await serveRepo(page);
  const response = await page.goto(PERMALINK);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(`fixtures/shop-demo at ${E2E_SHA.slice(0, 7)} · GitInside`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("fixtures / shop-demo");
  await settle(page);

  // The system level: two services, a datastore, an outside API, and their requests.
  const tree = page.getByRole("tree", { name: "Architecture" });
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  await expect(box(page, WEB)).toHaveAccessibleName("@shop/web, service");
  await expect(page.getByText("2 requests")).toBeVisible();
  await expect(heading(page)).toHaveText("shop-demo");
  // The layout ran off the main thread: the page started its worker.
  expect(page.workers().length).toBeGreaterThan(0);

  // First visit: the tips; "Don't show again" is remembered across a reload.
  await expect(page.getByText("Tip 1 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Don't show again" }).click();
  await expect(page.getByText("Tip 1 of 3")).toHaveCount(0);
  await page.reload();
  await settle(page);
  await expect(page.getByText(/Tip \d of \d/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("drill down with a double-click or Enter, back up with Esc", async ({ page }) => {
  const errors = watchErrors(page);
  await serveRepo(page);
  await open(page);
  const crumbs = page.getByRole("navigation", { name: "Drill-down path" });
  await expect(crumbs).toHaveText("shop-demo");

  await box(page, WEB).dblclick();
  await settle(page);
  await expect(box(page, WEB)).toHaveAttribute("aria-expanded", "true");
  await expect(box(page, CHECKOUT)).toBeVisible();
  await expect(box(page, CHECKOUT)).toHaveAttribute("aria-level", "2");
  await expect(crumbs).toContainText("@shop/web");

  await page.keyboard.press("Escape");
  await settle(page);
  await expect(box(page, WEB)).toHaveAttribute("aria-expanded", "false");
  await expect(box(page, CHECKOUT)).toHaveCount(0);

  // The keyboard way, with focus kept on the box that opened.
  await box(page, WEB).focus();
  await page.keyboard.press("Enter");
  await settle(page);
  await expect(box(page, CHECKOUT)).toBeVisible();
  await expect(box(page, WEB)).toBeFocused();
  expect(errors).toEqual([]);
});

test("select a page, trace its request, and reopen the same view from the link", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await serveRepo(page);
  await open(page);
  await box(page, WEB).dblclick();
  await settle(page);

  await box(page, CHECKOUT).click();
  await expect(heading(page)).toHaveText("/checkout");
  await expect(box(page, CHECKOUT)).toHaveAttribute("aria-selected", "true");
  // Announced with what it connects to.
  await expect(page.locator('.gi-explorer [aria-live="polite"]').first()).toContainText(
    "/checkout",
  );

  const entries = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: /Trace from here/ }).click();
  await expect(page.getByText("Step 1 of 8")).toBeVisible();
  await expect(heading(page)).toHaveText("page /checkout renders Checkout");
  await page.getByRole("button", { name: /Next step/ }).click();
  await expect(page.getByText("Step 2 of 8")).toBeVisible();
  const step2 = await heading(page).textContent();

  // The address keeps the view (replaceState, no new history entry), and a reload reopens it.
  await expect.poll(() => new URL(page.url()).search).not.toBe("");
  expect(new URL(page.url()).pathname).toBe(PERMALINK);
  const linked = page.url();
  expect(await page.evaluate(() => history.length)).toBe(entries);
  await page.reload();
  await settle(page);
  expect(page.url()).toBe(linked);
  await expect(page.getByText("Step 2 of 8")).toBeVisible();
  await expect(heading(page)).toHaveText(step2 ?? "");

  // Esc leaves the trace, then the selection.
  await box(page, WEB).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/Step \d of 8/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a long inspector scrolls inside itself; the page stays the window's height", async ({
  page,
}) => {
  // M4b.14b's trace screenshot: the steps stretched the page to 1110px at 800px, pushing the
  // minimap and legend below the window.
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveRepo(page);
  await open(page);
  await box(page, WEB).dblclick();
  await settle(page);
  await box(page, CHECKOUT).click();
  await page.getByRole("button", { name: /Trace from here/ }).click();
  await expect(page.getByText("Step 1 of 8")).toBeVisible();

  const size = await page.evaluate(() => {
    const inspector = document.querySelector(".gi-inspector");
    return {
      page: document.documentElement.scrollHeight,
      inspector: inspector ? inspector.scrollHeight - inspector.clientHeight : 0,
    };
  });
  expect(size.page).toBe(800);
  expect(size.inspector, "the inspector itself overflows and scrolls").toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Legend" })).toBeInViewport();
  expect(errors).toEqual([]);
});

test("a selection's code loads from GitHub at the commit, and Open on GitHub goes to its line", async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  const files = await serveRepo(page);
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>GitHub</title>" }),
  );
  await open(page);
  await box(page, WEB).dblclick();
  await settle(page);
  await box(page, CHECKOUT).click();

  const node = graph.nodes.find((n) => n.id === CHECKOUT);
  const source = node?.source;
  if (source === undefined) throw new Error(`${CHECKOUT} has no source in the fixture`);
  const href = `https://github.com/fixtures/shop-demo/blob/${E2E_SHA}/${source.file}#L${source.line}`;

  // The file, read once through the CSP's connect-src, the node's line highlighted and split
  // into Shiki's tokens (its grammar loaded under the CSP too).
  const code = page.getByRole("figure");
  await expect(code).not.toHaveAttribute("aria-busy", "true");
  const text = readFileSync(join(FIXTURE, source.file), "utf8").split("\n")[source.line - 1];
  const line = code.locator(".gi-code__line[data-highlight] > code");
  await expect(line).toHaveText((text ?? "").trim());
  await expect(line.locator("span[data-token]").first()).toBeVisible();
  expect(files).toEqual([source.file]);
  await expect(page.getByRole("link", { name: source.file })).toHaveAttribute("href", href);

  // The inspector's, not the repo bar's link to the whole repo.
  const link = page.getByRole("complementary").getByRole("link", { name: /Open on GitHub/ });
  await expect(link).toHaveAttribute("href", href);
  const popup = page.waitForEvent("popup");
  await link.click();
  expect((await popup).url()).toBe(href);
  expect(errors).toEqual([]);
});
