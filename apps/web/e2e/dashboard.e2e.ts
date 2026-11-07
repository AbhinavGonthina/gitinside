import { expect, test, type Page } from "@playwright/test";
import { E2E_APP_SLUG, PORTS } from "./fixture";

// The signed-in dashboard (M8.2c) against the production build, its database, and the fake
// GitHub (github.ts): sign-in's whole round trip through real cookies, then the dashboard's
// states. Serial: `/_fail` makes the fake's next call fail, whichever test makes it.
test.describe.configure({ mode: "serial" });

const SITE = `http://127.0.0.1:${PORTS.signedIn}`;
const GITHUB = `http://127.0.0.1:${PORTS.github}`;

/** Fails the test on any page error, console error, or CSP violation. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  return errors;
}

/** Where `path` on the site redirects to, not followed. */
async function redirectOf(page: Page, path: string): Promise<URL> {
  const response = await page.context().request.get(new URL(path, SITE).href, { maxRedirects: 0 });
  expect(response.status(), path).toBeGreaterThanOrEqual(300);
  expect(response.status(), path).toBeLessThan(400);
  return new URL(response.headers()["location"] ?? "", SITE);
}

/**
 * Sign in from the dashboard as `login`, as the browser would: `/dashboard` starts sign-in,
 * which sets the state cookie (in the context the page shares) and sends GitHub's authorize
 * page; the fake approves it as `login`, and the page opens the callback with that code.
 * Not with `page.route`: Playwright routes only a redirect chain's first request, so the
 * authorize hop would reach the real github.com.
 */
async function signInAs(page: Page, login: string) {
  const start = await redirectOf(page, "/dashboard");
  expect(start.pathname + start.search).toBe("/api/auth/github?returnTo=%2Fdashboard");
  const authorize = await redirectOf(page, start.href);
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");

  const approve = new URL("/_approve", GITHUB);
  approve.searchParams.set("url", authorize.href);
  approve.searchParams.set("login", login);
  const code = await (await fetch(approve)).text();
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  await page.goto(callback.href);
}

test("signing in from the dashboard comes back to the user's installations and repos", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signInAs(page, "octo");
  await expect(page).toHaveURL(`${SITE}/dashboard`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your repos");
  await expect(page).toHaveTitle(/^Your repos/);
  expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/noindex/);

  // Sorted by account, then by repo name; private repos marked; each opens its diagram.
  const acme = page.getByRole("region", { name: "acme" });
  await expect(acme.getByText("Organization · 3 repos selected")).toBeVisible();
  const rows = acme.locator(".repo-row");
  await expect(rows).toHaveText([
    "acme/api",
    "acme/billing-servicePrivate",
    "acme/storefrontPrivate",
  ]);
  await expect(rows.first()).toHaveAttribute("href", "/acme/api");
  const octo = page.getByRole("region", { name: "octo" });
  await expect(octo.getByText("Personal account · All repos")).toBeVisible();
  await expect(octo.locator(".repo-row")).toHaveCount(2);

  await expect(page.getByRole("link", { name: "Install on more repos" })).toHaveAttribute(
    "href",
    `https://github.com/apps/${E2E_APP_SLUG}/installations/new`,
  );
  // The header names the login, linking back here.
  await expect(page.getByRole("link", { name: "octo", exact: true })).toHaveAttribute(
    "href",
    "/dashboard",
  );
  expect(errors).toEqual([]);
});

test("says GitHub couldn't be read, and Try again lists the repos", async ({ page }) => {
  const errors = watchErrors(page);
  await signInAs(page, "octo");
  await expect(page.getByRole("region", { name: "acme" })).toBeVisible();

  expect((await fetch(new URL("/_fail", GITHUB), { method: "POST" })).ok).toBe(true);
  await page.reload();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert.getByRole("heading")).toHaveText("Your repos didn't load");
  // Still signed in: GitHub failing isn't the session ending.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "acme" })).toBeVisible();
  // In `main`: after a client navigation, Next's route announcer is an `alert` too.
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an account with nothing installed is shown how to install, once", async ({ page }) => {
  const errors = watchErrors(page);
  await signInAs(page, "newcomer");
  await expect(
    page.getByRole("heading", { name: "GitInside isn't installed on your repos yet" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Install GitInside" })).toHaveAttribute(
    "href",
    `https://github.com/apps/${E2E_APP_SLUG}/installations/new`,
  );
  await expect(page.getByRole("link", { name: "Install on more repos" })).toHaveCount(0);
  await expect(page.getByRole("region")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("after signing out, the dashboard asks to sign in again", async ({ page }) => {
  await signInAs(page, "octo");
  await expect(page.getByRole("region", { name: "acme" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();

  // The dashboard starts sign-in again: the old cookie opens no session.
  const start = await redirectOf(page, "/dashboard");
  expect(start.pathname).toBe("/api/auth/github");
});
