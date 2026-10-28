import { expect, test, type Page } from "@playwright/test";

/** Fails the test on any page error, console error, or CSP violation. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  return errors;
}

/** Waits until React has hydrated the form (its submit handler is attached). */
async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector("form.repo-form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactProps"));
  });
}

test("the landing page renders dark first, with our fonts, under a nonce CSP", async ({ page }) => {
  const errors = watchErrors(page);
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  const csp = response!.headers()["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toContain("unsafe-eval");
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response!.headers()["x-powered-by"]).toBeUndefined();

  // Every script Next.js wrote carries this response's nonce.
  const scriptNonces = await page.$$eval("script", (s) => s.map((el) => el.nonce));
  expect(scriptNonces.length).toBeGreaterThan(0);
  for (const n of scriptNonces) expect(n).toBe(nonce);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Git inside your repo.");
  await expect(page).toHaveTitle("GitInside: Git inside your repo.");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(html).toHaveClass("gi-root");
  // tokens.css applied: the dark canvas, not the browser default.
  expect(await html.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(11, 14, 20)");

  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
  );
  expect(loaded.some((f) => f.includes("Geist Variable"))).toBe(true);

  await hydrated(page);
  expect(errors).toEqual([]);
});

test("a bad URL gets an answer in place; a good one opens the repo page", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await hydrated(page);
  const field = page.getByRole("textbox", { name: "GitHub repo URL" });

  await field.fill("https://gitlab.com/acme/shop");
  await field.press("Enter");
  await expect(page.getByText("That isn't a GitHub repo URL.")).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await expect(page).toHaveURL("/");

  await field.fill("https://github.com/vercel/next.js/tree/canary");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page).toHaveURL("/vercel/next.js");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("vercel / next.js");
  await expect(page).toHaveTitle("vercel/next.js · GitInside");
  await expect(page.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/vercel/next.js",
  );
  expect(errors).toEqual([]);
});

test("the theme switch applies at once and survives a reload", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await hydrated(page);
  await page.getByRole("radio", { name: "Light" }).click();
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await html.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgb(245, 247, 250)",
  );

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  expect(errors).toEqual([]);
});

test("names GitHub wouldn't allow are a 404 that doesn't echo them", async ({ page }) => {
  const response = await page.goto("/settings/profile");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's no page here.");
  await expect(page.getByText("profile")).toHaveCount(0);
});
