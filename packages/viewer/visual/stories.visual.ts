import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareStrings } from "@gitinside/schema";
import { expect, test } from "@playwright/test";
import { visualCases } from "./cases.js";

// One full-page screenshot per story and theme, compared with the committed
// baseline in visual/baselines/. Linux CI only (TESTING.md): other systems
// rasterize text differently, so comparing there would only produce noise.

const indexFile = fileURLToPath(new URL("../storybook-static/index.json", import.meta.url));

function loadIndex(): unknown {
  try {
    return JSON.parse(readFileSync(indexFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Can't read ${indexFile}; run \`pnpm --filter @gitinside/viewer build-storybook\` first`,
      { cause: error },
    );
  }
}

test.skip(process.platform !== "linux", "Visual baselines are Linux-only (docs/TESTING.md)");

const cases = visualCases(loadIndex());

test("every baseline belongs to a story", () => {
  // A renamed or removed story would otherwise leave its old screenshot behind.
  // Capture runs (`--update-snapshots`) start from the committed folder, so only compare runs check.
  test.skip(test.info().config.updateSnapshots === "all", "capturing baselines");
  const dir = fileURLToPath(new URL("./baselines/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
  expect(files.sort(compareStrings)).toEqual(cases.map((c) => c.snapshot).sort(compareStrings));
});

for (const c of cases) {
  test(c.title, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto(c.url);
    await expect(page.locator("#storybook-root > *").first()).toBeAttached();
    // The preview decorator's root carries the theme from the URL global.
    await expect(
      page.locator(`#storybook-root > .gi-root[data-theme="${c.theme}"]`),
    ).toBeAttached();
    await expect(page.locator("body.sb-show-errordisplay")).toHaveCount(0);

    // The screenshot must show the real styles and fonts, not a fallback, and
    // the theme's canvas behind the whole page (no white iframe edge).
    await page.evaluate(() => document.fonts.ready);
    const look = await page.evaluate(() => {
      const root = document.querySelector("#storybook-root > .gi-root");
      const box = root?.getBoundingClientRect();
      const page = document.documentElement;
      return {
        background: root ? getComputedStyle(root).backgroundColor : "",
        covers:
          box !== undefined &&
          Math.ceil(box.width) >= page.scrollWidth &&
          Math.ceil(box.height) >= page.scrollHeight,
        geist: loaded("Geist Variable"),
        // Not every story sets code-like text; when one does, Geist Mono must have loaded.
        mono:
          ![...document.querySelectorAll("body *")].some((el) =>
            getComputedStyle(el).fontFamily.includes("Geist Mono"),
          ) || loaded("Geist Mono Variable"),
      };
      function loaded(family: string) {
        return [...document.fonts].some(
          (font) => font.family.replaceAll('"', "") === family && font.status === "loaded",
        );
      }
    });
    expect(look.background, "tokens.css applied").not.toMatch(
      /^(rgba\(0, 0, 0, 0\)|transparent|)$/,
    );
    expect(look.covers, "the themed root covers the page").toBe(true);
    expect(look.geist, "Geist loaded").toBe(true);
    expect(look.mono, "Geist Mono loaded where it's used").toBe(true);

    await expect(page).toHaveScreenshot(c.snapshot, { fullPage: true });
    expect(errors, "no errors while rendering").toEqual([]);
  });
}
