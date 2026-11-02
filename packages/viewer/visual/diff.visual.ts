import { expect, test, type Page } from "@playwright/test";

// Diff mode's Base / Head / Overlay switch (M6.9c) in a real browser: every
// box the next version shares stays exactly where it was through the switch,
// and what that version lacks fades out in place (at once under reduced
// motion). No screenshots, so it runs on every system, after `build-storybook`.

const STORY =
  "/iframe.html?id=explorer-explorer--diff-broken-down&viewMode=story&globals=theme:dark";

/** Each frame of a switch: shared boxes' places, and each left-out box's and line's look. */
interface Frame {
  places: Record<string, string>;
  absent: { id: string; opacity: number; visibility: string }[];
}

async function open(page: Page) {
  await page.goto(STORY);
  await expect(page.locator('.gi-drill[data-layout="done"]:not([aria-busy])')).toHaveCount(1);
  await expect(page.locator(".gi-explorer[data-settled]")).toHaveCount(1);
  // Wait for the first fit's camera to rest: two reads 150ms apart agree.
  await expect
    .poll(async () => {
      const a = await places(page);
      await page.waitForTimeout(150);
      return JSON.stringify(a) === JSON.stringify(await places(page));
    })
    .toBe(true);
}

/** Every drawn box's place on screen, by node ID. */
function places(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".gi-drill__node:not([data-leaving])")].map(
        (el) => {
          const r = el.getBoundingClientRect();
          return [el.dataset.nodeId ?? "", [r.x, r.y, r.width, r.height].map(Math.round).join()];
        },
      ),
    ),
  );
}

/** Clicks a version in the top bar and records every frame for 500ms. */
function switchTo(page: Page, version: "Base" | "Head" | "Overlay"): Promise<Frame[]> {
  return page.evaluate(async (name) => {
    const radio = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="radiogroup"][aria-label="Diff view"] [role="radio"]',
      ),
    ].find((r) => r.textContent === name);
    if (!radio) throw new Error(`no ${name} radio`);
    radio.click();
    const frames: Frame[] = [];
    const start = performance.now();
    while (performance.now() - start < 500) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const at: Record<string, string> = {};
      const absent: Frame["absent"] = [];
      for (const el of document.querySelectorAll<HTMLElement | SVGElement>(
        ".gi-drill__node:not([data-leaving]), .gi-drill .gi-edge[data-absent]",
      )) {
        const id = el instanceof HTMLElement ? (el.dataset.nodeId ?? "") : "line";
        const look = getComputedStyle(el);
        if (el.hasAttribute("data-absent")) {
          absent.push({ id, opacity: Number(look.opacity), visibility: look.visibility });
        } else {
          const r = el.getBoundingClientRect();
          at[id] = [r.x, r.y, r.width, r.height].map(Math.round).join();
        }
      }
      frames.push({ places: at, absent });
    }
    return frames;
  }, version);
}

/** No shared box moved in any frame, and the left-out ones faded (or vanished) in place. */
function expectSwitch(frames: Frame[], before: Record<string, string>, fades: boolean) {
  const last = frames.at(-1);
  expect(last, "frames recorded").toBeDefined();
  for (const [i, f] of frames.entries()) {
    for (const [id, place] of Object.entries(f.places)) {
      expect(place, `${id} in frame ${i}`).toBe(before[id]);
    }
  }
  for (const a of last?.absent ?? []) {
    expect([a.id, a.opacity, a.visibility]).toEqual([a.id, 0, "hidden"]);
  }
  const first = frames[0]?.absent ?? [];
  if (fades) {
    // Drawn while it fades, then gone: some frame catches it partway, still
    // visible (a hidden element reports its fading opacity too).
    expect(first.length, "something left out").toBeGreaterThan(0);
    const partway = frames.some((f) =>
      f.absent.some((a) => a.visibility === "visible" && a.opacity > 0 && a.opacity < 1),
    );
    expect(partway, "faded rather than vanished").toBe(true);
  } else {
    for (const a of first) expect([a.id, a.visibility]).toEqual([a.id, "hidden"]);
  }
}

test("switching Base, Head, and Overlay moves no box and fades the rest in place", async ({
  page,
}) => {
  await open(page);
  const before = await places(page);
  expect(Object.keys(before).length).toBeGreaterThan(10);

  expectSwitch(await switchTo(page, "Head"), before, true);
  expectSwitch(await switchTo(page, "Base"), before, true);
  const back = await switchTo(page, "Overlay");
  expectSwitch(back, before, false);
  expect(back.at(-1)?.absent, "everything drawn again").toEqual([]);
  expect(await places(page)).toEqual(before);
});

test("under reduced motion, what a version lacks is gone at once", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const before = await places(page);
  expectSwitch(await switchTo(page, "Head"), before, false);
});
