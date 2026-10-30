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
    // Laid-out stories (M4b.2b) draw once their Web Worker answers; a story
    // that fell back to the main thread means the worker broke in a browser.
    await expect(page.locator('[data-layout="pending"]')).toHaveCount(0);
    await expect(
      page.locator('[data-layout-runs-in="main"]'),
      "laid out in the worker",
    ).toHaveCount(0);
    // Code previews are plain until Shiki's chunks load (M4b.5b); shoot them colored.
    await expect(page.locator('.gi-code[data-syntax="pending"]')).toHaveCount(0);
    await expect(
      page.locator('.gi-code[data-syntax="plain"]'),
      "Shiki loaded and highlighted every preview",
    ).toHaveCount(0);

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

    // No node's content spills out of its box (design gate: count badges
    // wrapped out of a closed frame). Overflowing children grow scrollHeight
    // and scrollWidth even with overflow visible; only a browser can measure it.
    const spills = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".gi-node")]
        .filter((n) => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)
        .map((n) => n.getAttribute("aria-label") ?? n.textContent ?? ""),
    );
    expect(spills, "every node's content fits its box").toEqual([]);

    // A trace step's title wraps inside the inspector rather than running off
    // its edge (M4b.6a: "latestPosts requests GET {env:CMS_URL}/posts" was cut).
    const cutTitles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".gi-explorer__hop")]
        .filter((h) => {
          const panel = h.closest(".gi-inspector")?.getBoundingClientRect();
          return (
            h.scrollWidth > h.clientWidth + 1 ||
            (panel && h.getBoundingClientRect().right > panel.right)
          );
        })
        .map((h) => h.textContent ?? ""),
    );
    expect(cutTitles, "every trace step title fits the inspector").toEqual([]);

    // An open box's own row sits at its top, in the header room the layout
    // kept (M4b.3a: an open file's row centered behind its routes): at most
    // 24px down, plus a window's 10px title band, in diagram px (the
    // explorer scales its canvas to fit, M4b.3b1).
    const sunk = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".gi-drill__node[data-open] > .gi-node")]
        .filter((n) => {
          const tile = n.querySelector(".gi-icon-tile");
          const box = n.getBoundingClientRect();
          const scale = n.offsetHeight > 0 ? box.height / n.offsetHeight : 1;
          const band = n.dataset.shape === "window" ? 10 : 0;
          return tile && (tile.getBoundingClientRect().top - box.top) / scale > 24 + band;
        })
        .map((n) => n.getAttribute("aria-label") ?? ""),
    );
    expect(sunk, "an open box's own row sits at its top").toEqual([]);

    // Each edge label the layout made room for is no wider than that room:
    // its size was estimated from its words before anything was drawn.
    // And no two laid-out pills cover each other.
    const labels = await page.evaluate(() => {
      const pills = [
        ...document.querySelectorAll<HTMLElement>(".gi-edge-label[data-measured-width]"),
      ].map((l) => ({
        text: l.textContent ?? "",
        room: Number(l.dataset.measuredWidth),
        r: l.getBoundingClientRect(),
      }));
      return {
        wide: pills.filter((p) => p.r.width > p.room + 0.5).map((p) => `${p.text}: ${p.r.width}px`),
        covered: pills.flatMap((a, i) =>
          pills
            .slice(i + 1)
            .filter(
              ({ r: b }) =>
                a.r.left < b.right &&
                b.left < a.r.right &&
                a.r.top < b.bottom &&
                b.top < a.r.bottom,
            )
            .map((b) => `${a.text} / ${b.text}`),
        ),
      };
    });
    expect(labels.wide, "every edge label fits the room the layout kept").toEqual([]);
    expect(labels.covered, "no edge label covers another").toEqual([]);

    await expect(page).toHaveScreenshot(c.snapshot, { fullPage: true });
    expect(errors, "no errors while rendering").toEqual([]);
  });
}
