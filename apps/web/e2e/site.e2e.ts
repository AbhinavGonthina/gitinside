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

test("a bad URL gets an answer in place, without a request", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await hydrated(page);
  const field = page.getByRole("textbox", { name: "GitHub repo URL" });
  let posted = false;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/analyze")) posted = true;
  });

  await field.fill("https://gitlab.com/acme/shop");
  await field.press("Enter");
  await expect(page.getByText("That isn't a GitHub repo URL.")).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await expect(page).toHaveURL("/");
  expect(posted).toBe(false);
  expect(errors).toEqual([]);
});

test("a good URL goes to /api/analyze; while unconfigured it says so in place", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await hydrated(page);
  const field = page.getByRole("textbox", { name: "GitHub repo URL" });
  await field.fill("https://github.com/vercel/next.js/tree/canary");
  const posted = page.waitForRequest("**/api/analyze");
  await page.getByRole("button", { name: "Analyze" }).click();
  expect((await posted).postDataJSON()).toEqual({
    url: "https://github.com/vercel/next.js/tree/canary",
  });
  await expect(
    page.getByText("Analysis is temporarily unavailable. Already-analyzed repos still work."),
  ).toBeVisible();
  await expect(field).toBeFocused();
  await expect(page).toHaveURL("/");
  // The browser logs the 503 itself; nothing else may go wrong.
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("a queued commit opens its progress page, which opens the repo when done", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const job = `analyze-${"a".repeat(32)}`;
  await page.route("**/api/analyze", (route) =>
    route.fulfill({
      status: 202,
      json: { status: "queued", jobId: job, owner: "vercel", repo: "next.js", sha: "c".repeat(40) },
    }),
  );
  // A worker's whole run in one response; EventSource handles each event as it's parsed.
  const view = (v: object) => `event: status\ndata: ${JSON.stringify(v)}\n\n`;
  await page.route(`**/api/jobs/${job}/events`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body:
        "retry: 60000\n\n" +
        view({ state: "running", step: "analyze", progress: 34, text: "Parsing 1,204 files" }),
    }),
  );
  await page.goto("/");
  await hydrated(page);
  await page.getByRole("textbox", { name: "GitHub repo URL" }).fill("vercel/next.js");
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page).toHaveURL(`/vercel/next.js/jobs/${job}`);
  await expect(page).toHaveTitle("Analyzing vercel/next.js · GitInside");
  const robots = page.locator('meta[name="robots"]');
  await expect(robots).toHaveAttribute("content", /noindex/);
  await expect(page.locator('[aria-current="step"]')).toHaveText("AnalyzingParsing 1,204 files");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "34");

  await page.unroute(`**/api/jobs/${job}/events`);
  await page.route(`**/api/jobs/${job}/events`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: view({ state: "done" }),
    }),
  );
  await page.reload();
  await expect(page).toHaveURL("/vercel/next.js");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("vercel / next.js");
  expect(errors).toEqual([]);
});

test("the real event stream says unavailable while the worker isn't configured", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const job = `analyze-${"b".repeat(32)}`;
  const response = await page.goto(`/acme/shop/jobs/${job}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme / shop");
  // Scoped to the page: Next.js adds its own (empty) route announcer alert.
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Analysis is temporarily unavailable. Already-analyzed repos still work.",
  );
  expect(errors).toEqual([]);
});

test("/api/jobs answers 503 while unconfigured and 404 for IDs it never issues", async ({
  request,
}) => {
  const ok = await request.get(`/api/jobs/analyze-${"c".repeat(32)}`);
  expect(ok.status()).toBe(503);
  expect((await ok.json()).state).toBe("unavailable");
  expect((await request.get("/api/jobs/analyze-1")).status()).toBe(404);
  expect((await request.get("/api/jobs/analyze-1/events")).status()).toBe(404);
});

test("a progress page for a malformed job is a 404", async ({ page }) => {
  const response = await page.goto("/acme/shop/jobs/analyze-123");
  expect(response?.status()).toBe(404);
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

test("/api/analyze answers JSON only, and says so plainly while unconfigured", async ({
  request,
}) => {
  // The E2E server has no database or worker, so a valid request is "temporarily unavailable".
  const ok = await request.post("/api/analyze", { data: { url: "acme/shop" } });
  expect(ok.status()).toBe(503);
  expect(await ok.json()).toEqual({
    error: "UNAVAILABLE",
    message: "Analysis is temporarily unavailable. Already-analyzed repos still work.",
  });
  expect(ok.headers()["cache-control"]).toBe("no-store");

  const form = await request.post("/api/analyze", { form: { url: "acme/shop" } });
  expect(form.status()).toBe(415);
  const get = await request.get("/api/analyze");
  expect(get.status()).toBe(405);
});

test("names GitHub wouldn't allow are a 404 that doesn't echo them", async ({ page }) => {
  const response = await page.goto("/settings/profile");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("There's no page here.");
  await expect(page.getByText("profile")).toHaveCount(0);
});
