import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStrings } from "@gitinside/schema";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SHA } from "./fixture";

// Visual regression for the website's key screens (M4b.14b): the landing page, the repo page's
// diagram, a selection, and a trace, each in dark and light, on the production build of the
// seeded server (explorer.e2e.ts). Compared with the committed baselines in e2e/baselines/ in
// CI's `web-e2e` container; captured by the "Visual baselines" workflow. Linux CI only
// (docs/TESTING.md): other systems rasterize text differently.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(HERE, "../../../fixtures/shop-demo");
const graph = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
  repo: Record<string, string>;
};
const PERMALINK = `/fixtures/shop-demo/${E2E_SHA}`;
const WEB = "service:web/";
const CHECKOUT = "page:web//checkout";
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** Each screen: how to reach it from a fresh page in the given theme. */
const SCREENS: Record<string, (page: Page) => Promise<void>> = {
  landing: async (page) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Git inside your repo.");
  },
  diagram: async (page) => {
    await openRepo(page);
  },
  selection: async (page) => {
    await openRepo(page);
    await box(page, WEB).dblclick();
    await settle(page);
    await box(page, CHECKOUT).click();
    await expect(heading(page)).toHaveText("/checkout");
    await codeLoaded(page);
  },
  trace: async (page) => {
    await openRepo(page);
    await box(page, WEB).dblclick();
    await settle(page);
    await box(page, CHECKOUT).click();
    await page.getByRole("button", { name: /Trace from here/ }).click();
    await page.getByRole("button", { name: /Next step/ }).click();
    await page.getByRole("button", { name: /Next step/ }).click();
    await expect(page.getByText("Step 3 of 8")).toBeVisible();
    await settle(page);
  },
};

const snapshot = (screen: string, theme: Theme) => `${screen}--${theme}.png`;

test.skip(process.platform !== "linux", "Visual baselines are Linux-only (docs/TESTING.md)");

test("every baseline belongs to a screen", () => {
  // A renamed or removed screen would otherwise leave its old image behind.
  test.skip(test.info().config.updateSnapshots === "all", "capturing baselines");
  const files = readdirSync(join(HERE, "baselines")).filter((f) => f.endsWith(".png"));
  const expected = Object.keys(SCREENS).flatMap((s) => THEMES.map((t) => snapshot(s, t)));
  expect(files.sort(compareStrings)).toEqual(expected.sort(compareStrings));
});

for (const [screen, reach] of Object.entries(SCREENS)) {
  for (const theme of THEMES) {
    test(`${screen} (${theme})`, async ({ page, context, baseURL }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
      });
      // The site's theme comes from its cookie on the server (dark when there's none).
      if (theme === "light") {
        await context.addCookies([{ name: "gi-theme", value: "light", url: baseURL ?? "" }]);
      }
      await serveRepo(page);
      await reach(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

      // Real fonts, not a fallback; the pointer off the canvas so no box is hovered.
      await page.evaluate(() => document.fonts.ready);
      const geist = await page.evaluate(() =>
        [...document.fonts].some(
          (f) => f.family.replaceAll('"', "") === "Geist Variable" && f.status === "loaded",
        ),
      );
      expect(geist, "Geist loaded").toBe(true);
      await page.mouse.move(0, 0);

      await expect(page).toHaveScreenshot(snapshot(screen, theme), { fullPage: true });
      expect(errors, "no errors while rendering").toEqual([]);
    });
  }
}

/** Answers the graph and the code previews' file reads, as explorer.e2e.ts does. */
async function serveRepo(page: Page) {
  await page.route(`**/api/graph/fixtures/shop-demo/${E2E_SHA}`, (route) =>
    route.fulfill({ json: { ...graph, repo: { ...graph.repo, sha: E2E_SHA } } }),
  );
  const raw = `https://raw.githubusercontent.com/fixtures/shop-demo/${E2E_SHA}/`;
  await page.route(`${raw}**`, (route) =>
    route.fulfill({
      body: readFileSync(join(FIXTURE, route.request().url().slice(raw.length)), "utf8"),
      headers: { "access-control-allow-origin": "*", "content-type": "text/plain" },
    }),
  );
}

/** Opens the permalink with the first-visit tips put away, laid out. */
async function openRepo(page: Page) {
  await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await page.goto(PERMALINK);
  await settle(page);
}

/** Waits until the canvas has laid out and drawn the current level. */
async function settle(page: Page) {
  await expect(page.locator(".gi-drill")).toHaveAttribute("data-layout", "done", {
    timeout: 30_000,
  });
  await expect(page.locator(".gi-drill")).not.toHaveAttribute("aria-busy", /.*/);
}

/** Waits until the inspector's code preview has loaded and Shiki has colored it. */
async function codeLoaded(page: Page) {
  const code = page.locator(".gi-code");
  await expect(code).toHaveCount(1);
  await expect(code).toHaveAttribute("data-syntax", "done", { timeout: 15_000 });
  await expect(code.locator("span[data-token]").first()).toBeVisible();
}

/** A box on the canvas by node ID (not one folding away). */
const box = (page: Page, id: string) =>
  page.locator(`.gi-drill__node:not([data-leaving])[data-node-id="${id}"] > .gi-node`);

/** The inspector's title. */
const heading = (page: Page) => page.getByRole("complementary").getByRole("heading", { level: 2 });
