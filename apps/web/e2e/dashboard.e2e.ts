import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { E2E_APP_SLUG, E2E_PRIVATE, E2E_SHA, PORTS } from "./fixture";

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
async function signInAs(page: Page, login: string, from = "/dashboard") {
  const start = await redirectOf(page, from);
  expect(start.pathname).toBe("/api/auth/github");
  if (from === "/dashboard") expect(start.search).toBe("?returnTo=%2Fdashboard");
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

/** GitHub's redirect after installing the app (M8.3b): a code, the installation, no state. */
const installReturn = (installationId: number) =>
  `/api/auth/github/callback?code=issued-on-github&installation_id=${installationId}&setup_action=install`;

test("installing returns to the dashboard, which names the installation GitHub confirmed", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signInAs(page, "octo");
  await expect(page.getByRole("region", { name: "acme" })).toBeVisible();

  await page.goto(`${SITE}${installReturn(41)}`);
  await expect(page).toHaveURL(`${SITE}/dashboard?install=installed&installation=41`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "GitInside is installed on acme.",
  );
  await expect(page.getByRole("region", { name: "acme" })).toBeVisible();

  // An installation GitHub doesn't list for this user is never taken from the query.
  await page.goto(`${SITE}${installReturn(999)}`);
  await expect(page).toHaveURL(`${SITE}/dashboard?install=unverified`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    /^GitHub doesn't list that installation for your account, so nothing changed\./,
  );
  expect(errors).toEqual([]);
});

test("a signed-out installer signs in through the site, then lands on the dashboard", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await signInAs(page, "octo", installReturn(7));
  await expect(page).toHaveURL(`${SITE}/dashboard?install=installed&installation=7`);
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "GitInside is installed on octo.",
  );
  expect(errors).toEqual([]);
});

// Private repos (M8.4c2c): acme/storefront's diagram and acme/billing-service's running job
// are in the site's database (database.ts), GitHub shows both to octo only (github.ts).
const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/shop-demo");
const MISSING = /^We couldn't find this analysis\./;

/**
 * Answers the browser's read of storefront's graph with shop-demo's (the site has no bucket;
 * the graph route's private check is unit-tested in lib/graphRoute.test.ts).
 */
async function serveStorefront(page: Page) {
  const graph = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
    repo: Record<string, string>;
  };
  // `*`: the page asks with its analyzer version in the query (`?v=`, ADR-0258).
  await page.route(`**/api/graph/acme/storefront/${E2E_SHA}*`, (route) =>
    route.fulfill({
      json: { ...graph, repo: { ...graph.repo, owner: "acme", name: "storefront", sha: E2E_SHA } },
    }),
  );
}

/** Waits until the explorer has laid out and drawn the diagram. */
async function drawn(page: Page) {
  await expect(page.locator(".gi-drill")).toHaveAttribute("data-layout", "done", {
    timeout: 30_000,
  });
}

test("a private repo's dashboard link opens its diagram, kept out of search engines", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await serveStorefront(page);
  await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await signInAs(page, "octo");
  await page.locator('.repo-row[href="/acme/storefront"]').click();
  await expect(page).toHaveURL(`${SITE}/acme/storefront`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme / storefront");
  await drawn(page);
  expect(await page.locator('meta[name="robots"]').getAttribute("content")).toMatch(/noindex/);
  expect(errors).toEqual([]);
});

test("a private repo's code preview reads through the site with the viewer's token; its badge is link-only", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await serveStorefront(page);
  const raw: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://raw.githubusercontent.com/")) raw.push(r.url());
  });
  await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await signInAs(page, "octo");
  const checkout = "page:web//checkout";
  await page.goto(`${SITE}/acme/storefront?sel=${checkout}`);
  await drawn(page);

  // The file comes from our route (session, access check, the fake GitHub with octo's token).
  const graph = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
    nodes: { id: string; source?: { file: string; line: number } }[];
  };
  const source = graph.nodes.find((n) => n.id === checkout)?.source;
  if (source === undefined) throw new Error(`${checkout} has no source in the fixture`);
  const code = page.getByRole("figure");
  await expect(code).not.toHaveAttribute("aria-busy", "true");
  const text = readFileSync(join(FIXTURE, source.file), "utf8").split("\n")[source.line - 1];
  await expect(code.locator(".gi-code__line[data-highlight] > code")).toHaveText(
    (text ?? "").trim(),
  );
  expect(raw).toEqual([]);

  // Signed in as someone else, the same file is the missing answer.
  const url = `${SITE}/api/source/acme/storefront/${E2E_SHA}/${source.file}`;
  expect((await page.context().request.get(url)).status()).toBe(200);
  await page.context().clearCookies();
  await signInAs(page, "newcomer");
  expect((await page.context().request.get(url)).status()).toBe(404);

  // Add to README offers the link-only badge alone. Its preview is answered by the unconfigured
  // site's badge (the same link-only bytes): this site's would ask the real GitHub for a name
  // with no public analysis (lib/imageRoute.test.ts covers that answer).
  await page.route("**/api/badge/**", async (route) => {
    const linkOnly = `http://127.0.0.1:${PORTS.unconfigured}/api/badge/acme/storefront.svg`;
    await route.fulfill({ response: await route.fetch({ url: linkOnly }) });
  });
  await page.context().clearCookies();
  await signInAs(page, "octo");
  await page.goto(`${SITE}/acme/storefront`);
  await page.getByRole("button", { name: "Add to README" }).click();
  const panel = page.getByRole("region", { name: "Add to README" });
  await expect(panel).toContainText("This repo is private, so its badge shows no counts");
  await expect(panel.getByRole("radio")).toHaveCount(0);
  const badge = panel.getByRole("img");
  await expect
    .poll(() => badge.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("a private job's progress page shows the analysis only to someone GitHub shows the repo to", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const progress = `${SITE}/acme/billing-service/jobs/${E2E_PRIVATE.billing.job}`;
  const failure = page.getByRole("main").getByRole("alert");

  // Signed out, then signed in without access: exactly a job that doesn't exist.
  await page.goto(progress);
  await expect(failure).toHaveText(MISSING);
  await signInAs(page, "newcomer");
  await page.goto(progress);
  await expect(failure).toHaveText(MISSING);
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  await page.context().clearCookies();
  await signInAs(page, "octo");
  await page.goto(progress);
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "Analyzing: Parsing 1,204 files",
  );
  await expect(page.getByRole("region", { name: "Found so far" })).toContainText("2 routes");
  await expect(failure).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a finished private job's progress page opens the diagram", async ({ page }) => {
  const errors = watchErrors(page);
  await serveStorefront(page);
  await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await signInAs(page, "octo");
  await page.goto(`${SITE}/acme/storefront/jobs/${E2E_PRIVATE.storefront.job}`);
  await expect(page).toHaveURL(`${SITE}/acme/storefront`);
  await drawn(page);
  expect(errors).toEqual([]);
});

// Not the signed-out latest page: a name with no public analysis is asked of the real GitHub.
test("signed out, or signed in without access, a private repo's permalink is a 404", async ({
  page,
}) => {
  const permalink = `${SITE}/acme/storefront/${E2E_SHA}`;
  expect((await page.goto(permalink))?.status()).toBe(404);
  await signInAs(page, "newcomer");
  expect((await page.goto(permalink))?.status()).toBe(404);
  await page.context().clearCookies();
  await signInAs(page, "octo");
  expect((await page.goto(permalink))?.status()).toBe(200);
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
