import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PRIVATE, E2E_SHA, PORTS } from "./fixture";

// The accessibility audit (M9.6): axe-core's WCAG 2.2 A and AA rules on every page of the
// production build, in both themes, and on the explorer with each of its overlays open. A
// screen passes only with no violation at all; axe's "needs review" results (contrast over
// an image, say) aren't failures, and docs/milestones/M9/a11y.md records how those were checked
// by hand. The three servers are the other E2E projects' (playwright.config.ts): pages that
// need no data on the unconfigured site, the repo page on the seeded one, the dashboard on the
// signed-in one.

const UNCONFIGURED = `http://127.0.0.1:${PORTS.unconfigured}`;
const SEEDED = `http://127.0.0.1:${PORTS.seeded}`;
const SIGNED_IN = `http://127.0.0.1:${PORTS.signedIn}`;
const GITHUB = `http://127.0.0.1:${PORTS.github}`;

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "../../../fixtures/shop-demo");
const graph = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as {
  repo: Record<string, string>;
};
const PERMALINK = `${SEEDED}/fixtures/shop-demo/${E2E_SHA}`;
const WEB = "service:web/";
const CHECKOUT = "page:web//checkout";
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** The rule sets audited: WCAG 2.0, 2.1, and 2.2 at levels A and AA (docs/UX.md's floor). */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/** Runs axe on the page as it is now and fails with each violation's rule and elements. */
async function audit(page: Page) {
  // An entrance fade read halfway gives a blend of text and background, not the text's color.
  // Waited for until a frame passes with none running: content that arrives later (a job's
  // facts after its first status) starts its own fade after the first wait.
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < 20; i++) {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
      if (running.length === 0) {
        await frame();
        await frame();
        if (
          document
            .getAnimations()
            .every(
              (a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity,
            )
        )
          return;
        continue;
      }
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
    }
  });
  const { violations, incomplete } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  // What axe couldn't decide (text over a gradient, say), kept in the report for a person.
  for (const v of incomplete) {
    test.info().annotations.push({
      type: "axe needs review",
      description: `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    });
  }
  const found = [];
  for (const v of violations) {
    const nodes = [];
    for (const n of v.nodes) {
      const target = n.target.join(" ");
      if (v.id === LABEL_IN_NAME && (await labelStartsName(page, target))) continue;
      nodes.push(`${target}: ${n.failureSummary ?? ""}`);
    }
    if (nodes.length) found.push({ rule: v.id, impact: v.impact, help: v.help, nodes });
  }
  expect(found, "axe violations").toEqual([]);
}

/**
 * axe's check of WCAG 2.5.3 (Label in Name, ACT rule 2ee8b8) takes all of a named element's
 * visible text as its label. A canvas box shows its name and, under it, a subtitle, counts,
 * or a model's fields: supplementary text, read as the box's description (DiagramNode.tsx),
 * not part of the label. So the rule is accepted on a box, and only a box, whose accessible
 * name starts with the words of its visible name (what a speech-input user would say), and
 * whose exposed text is that name alone. Anything else it flags fails the audit.
 */
const LABEL_IN_NAME = "label-content-name-mismatch";

async function labelStartsName(page: Page, target: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el?.matches(".gi-drill__node > .gi-node")) return false;
    const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const label = words(el.querySelector(".gi-node__label")?.textContent ?? "");
    const name = words(el.getAttribute("aria-label") ?? "");
    const exposed: string[] = [];
    const walk = (n: Node) => {
      if (n instanceof HTMLElement && (n.hidden || n.getAttribute("aria-hidden") === "true")) {
        return;
      }
      if (n.nodeType === Node.TEXT_NODE) exposed.push(n.textContent ?? "");
      n.childNodes.forEach(walk);
    };
    walk(el);
    return (
      label.length > 0 &&
      label.every((w, i) => name[i] === w) &&
      words(exposed.join(" ")).join(" ") === label.join(" ")
    );
  }, target);
}

/** Opens `url` in `theme` (the site reads its theme cookie on the server; dark by default). */
async function visit(page: Page, url: string, theme: Theme) {
  if (theme === "light") {
    await page.context().addCookies([{ name: "gi-theme", value: "light", url }]);
  }
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Waits until React has hydrated the page (the theme switch's handlers attached). */
async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const radio = document.querySelector('[role="radio"]');
    return !!radio && Object.keys(radio).some((k) => k.startsWith("__reactProps"));
  });
}

/** Answers the repo page's graph and code reads, as explorer.e2e.ts does. */
async function serveRepo(page: Page) {
  await page.route(`**/api/graph/fixtures/shop-demo/${E2E_SHA}*`, (route) =>
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

/** Opens the permalink, laid out; the first-visit tips put away unless `tips`. */
async function openRepo(page: Page, theme: Theme, url = PERMALINK, tips = false) {
  await serveRepo(page);
  if (!tips) await page.addInitScript(() => localStorage.setItem("gitinside.onboarding", "done"));
  await visit(page, url, theme);
  await settle(page);
}

/** Drills into the web service and selects its checkout page, code loaded. */
async function selectCheckout(page: Page) {
  await box(page, WEB).dblclick();
  await settle(page);
  await box(page, CHECKOUT).click();
  await expect(page.locator(".gi-code")).toHaveAttribute("data-syntax", "done", {
    timeout: 15_000,
  });
}

/** Pages on the unconfigured site, each by how to reach it. */
const SITE: Record<string, (page: Page, theme: Theme) => Promise<void>> = {
  landing: async (page, theme) => {
    await visit(page, `${UNCONFIGURED}/`, theme);
    await hydrated(page);
  },
  "landing with a bad URL": async (page, theme) => {
    await visit(page, `${UNCONFIGURED}/`, theme);
    await hydrated(page);
    const field = page.getByRole("textbox", { name: "GitHub repo URL" });
    await field.fill("https://gitlab.com/acme/shop");
    await field.press("Enter");
    await expect(field).toHaveAttribute("aria-invalid", "true");
  },
  "how it works": (page, theme) => visit(page, `${UNCONFIGURED}/how-it-works`, theme),
  limits: (page, theme) => visit(page, `${UNCONFIGURED}/limits`, theme),
  privacy: (page, theme) => visit(page, `${UNCONFIGURED}/privacy`, theme),
  "self-hosting": (page, theme) => visit(page, `${UNCONFIGURED}/self-hosting`, theme),
  "not found": (page, theme) => visit(page, `${UNCONFIGURED}/settings/profile`, theme),
  "job progress": async (page, theme) => {
    await visit(page, `${UNCONFIGURED}/acme/shop/jobs/analyze-${"b".repeat(32)}`, theme);
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  },
  "unavailable permalink": async (page, theme) => {
    await visit(page, `${UNCONFIGURED}/acme/shop/${"d".repeat(40)}`, theme);
    await expect(page.getByText(/temporarily unavailable/)).toBeVisible();
  },
};

/** The repo page on the seeded site, each state by how to reach it. */
const REPO: Record<string, (page: Page, theme: Theme) => Promise<void>> = {
  "first visit tips": async (page, theme) => {
    await openRepo(page, theme, PERMALINK, true);
    await expect(page.getByText("Tip 1 of 3")).toBeVisible();
  },
  diagram: async (page, theme) => {
    await openRepo(page, theme);
    // The text under a box's name is its description, as Chromium computes it (DiagramNode.tsx).
    const db = page.locator(".gi-drill__node > .gi-node[data-kind='datastore']");
    await expect(db).toHaveAccessibleName("db, datastore");
    await expect(db).toHaveAccessibleDescription("PostgreSQL");
    await expect(box(page, WEB)).toHaveAccessibleDescription(/^Next\.js, apps\/web, \d+ \w+/);
  },
  selection: async (page, theme) => {
    await openRepo(page, theme);
    await selectCheckout(page);
  },
  trace: async (page, theme) => {
    await openRepo(page, theme);
    await selectCheckout(page);
    await page.getByRole("button", { name: /Trace from here/ }).click();
    await page.getByRole("button", { name: /Next step/ }).click();
    await expect(page.getByText("Step 2 of 8")).toBeVisible();
    await settle(page);
  },
  "trace picker": async (page, theme) => {
    // The repo page's header has no trace button; T opens the picker (UX.md).
    await openRepo(page, theme);
    await box(page, WEB).focus();
    await page.keyboard.press("t");
    await expect(page.getByRole("dialog", { name: "Trace a request" })).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
  },
  legend: async (page, theme) => {
    await openRepo(page, theme);
    await page.getByRole("button", { name: "Legend" }).click();
    await expect(page.getByRole("button", { name: "Close legend" })).toBeVisible();
  },
  search: async (page, theme) => {
    await openRepo(page, theme);
    await box(page, WEB).focus();
    await page.keyboard.press("Control+k");
    const field = page.getByRole("combobox", { name: "Search services, files, routes" });
    await field.fill("check");
    await expect(page.getByRole("option").first()).toBeVisible();
  },
  filters: async (page, theme) => {
    await openRepo(page, theme);
    await page.getByRole("button", { name: "Filters" }).click();
    await expect(page.locator(".gi-filters[data-state='open']")).toBeVisible();
  },
  share: async (page, theme) => {
    await openRepo(page, theme);
    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("group", { name: "Export this view" })).toBeVisible();
  },
  "add to README": async (page, theme) => {
    // The preview is the repo's latest image, which asks GitHub for the repo's latest commit;
    // this fixture isn't on GitHub, and the server would then hide its pages from later tests.
    await page.route(/\/api\/(badge|diagram)\//, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20"/>',
      }),
    );
    await openRepo(page, theme);
    await page.getByRole("button", { name: "Add to README" }).click();
    await expect(page.getByRole("region", { name: "Add to README" })).toBeVisible();
  },
  "compared with a commit": async (page, theme) => {
    await openRepo(page, theme, `${PERMALINK}?base=${E2E_SHA}`);
    await expect(page.locator(".gi-status[data-tone='diff']")).toHaveText(/^Comparing /);
  },
};

for (const theme of THEMES) {
  for (const [name, reach] of Object.entries(SITE)) {
    test(`${name} (${theme})`, async ({ page }) => {
      await reach(page, theme);
      await audit(page);
    });
  }
  for (const [name, reach] of Object.entries(REPO)) {
    test(`repo page: ${name} (${theme})`, async ({ page }) => {
      await reach(page, theme);
      await audit(page);
    });
  }
}

/** Where `url` redirects to, not followed. */
async function redirectOf(page: Page, url: string): Promise<URL> {
  const response = await page.context().request.get(url, { maxRedirects: 0 });
  return new URL(response.headers()["location"] ?? "", SIGNED_IN);
}

/** Signs in as `login` through the fake GitHub, as dashboard.e2e.ts's `signInAs` does. */
async function signIn(page: Page, login: string) {
  const start = await redirectOf(page, `${SIGNED_IN}/dashboard`);
  const authorize = await redirectOf(page, start.href);
  const approve = new URL("/_approve", GITHUB);
  approve.searchParams.set("url", authorize.href);
  approve.searchParams.set("login", login);
  const code = await (await fetch(approve)).text();
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  await page.goto(callback.href);
}

test.describe("signed in", () => {
  // The fake GitHub's `/_fail` is shared with dashboard.e2e.ts; these never call it.
  test.describe.configure({ mode: "serial" });

  for (const theme of THEMES) {
    test(`dashboard (${theme})`, async ({ page }) => {
      await signIn(page, "octo");
      await visit(page, `${SIGNED_IN}/dashboard`, theme);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your repos");
      await audit(page);
    });

    test(`private job progress (${theme})`, async ({ page }) => {
      await signIn(page, "octo");
      const { billing } = E2E_PRIVATE;
      await visit(page, `${SIGNED_IN}/acme/billing-service/jobs/${billing.job}`, theme);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme / billing-service");
      await expect(page.locator(".progress__facts")).toBeVisible();
      await audit(page);
    });
  }
});
