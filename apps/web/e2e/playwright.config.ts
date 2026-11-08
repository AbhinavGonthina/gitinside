import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { FAKE_CLIENT } from "../lib/githubOAuth.testkit";
import { E2E_APP_SLUG, E2E_SESSION_SECRET, E2E_SHA, PORTS } from "./fixture";

// End-to-end tests against the production build (`next build` first; turbo
// does it in CI). They catch what unit tests can't: the CSP actually letting
// hydration run, the fonts and tokens loading, cookies across reloads.
//
// Two servers of the same build: `unconfigured` has no database or worker, so
// every API says "temporarily unavailable" (site.e2e.ts); `seeded` reads a
// PGlite database holding one finished analysis of fixtures/shop-demo
// (database.ts), so the repo page draws the explorer (explorer.e2e.ts). A third,
// `signed-in`, reads its own copy of that database with sign-in set up against a fake
// GitHub (github.ts) for the dashboard (dashboard.e2e.ts, M8.2c): PGlite is one session,
// so sharing it let the seeded site's reads run beside the dashboard's. The `visual`
// project screenshots the key screens on the seeded server against e2e/baselines/
// (screens.visual.ts, Linux CI only; re-capture with the "Visual baselines" workflow).

const web = fileURLToPath(new URL("..", import.meta.url));
const next = (port: number) => `pnpm exec next start --hostname 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: ["*.e2e.ts", "*.visual.ts"],
  outputDir: "../dist/e2e-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../dist/e2e-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "unconfigured",
      testMatch: "site.e2e.ts",
      use: { baseURL: `http://127.0.0.1:${PORTS.unconfigured}` },
    },
    {
      name: "seeded",
      testMatch: "explorer.e2e.ts",
      use: { baseURL: `http://127.0.0.1:${PORTS.seeded}` },
    },
    {
      name: "signed-in",
      testMatch: "dashboard.e2e.ts",
      use: { baseURL: `http://127.0.0.1:${PORTS.signedIn}` },
    },
    {
      // Same settings as the viewer's visual tests (packages/viewer/visual).
      name: "visual",
      testMatch: "screens.visual.ts",
      snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
      use: {
        baseURL: `http://127.0.0.1:${PORTS.seeded}`,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      },
      expect: {
        toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" },
      },
    },
  ],
  webServer: [
    {
      command: next(PORTS.unconfigured),
      cwd: web,
      url: `http://127.0.0.1:${PORTS.unconfigured}/icon.svg`,
      reuseExistingServer: false,
    },
    {
      command: `node --experimental-strip-types e2e/database.ts ${PORTS.database} ${E2E_SHA}`,
      cwd: web,
      wait: { stdout: /^seeded /m },
      stdout: "pipe",
      reuseExistingServer: false,
    },
    {
      command: next(PORTS.seeded),
      cwd: web,
      url: `http://127.0.0.1:${PORTS.seeded}/icon.svg`,
      env: {
        DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORTS.database}/postgres`,
      },
      reuseExistingServer: false,
    },
    {
      command: `node --experimental-strip-types e2e/database.ts ${PORTS.signedInDatabase} ${E2E_SHA} private`,
      cwd: web,
      wait: { stdout: /^seeded /m },
      stdout: "pipe",
      reuseExistingServer: false,
    },
    {
      command: `node --experimental-strip-types e2e/github.ts ${PORTS.github}`,
      cwd: web,
      wait: { stdout: /^listening /m },
      stdout: "pipe",
      reuseExistingServer: false,
    },
    {
      command: next(PORTS.signedIn),
      cwd: web,
      url: `http://127.0.0.1:${PORTS.signedIn}/icon.svg`,
      env: {
        DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORTS.signedInDatabase}/postgres`,
        GITHUB_APP_CLIENT_ID: FAKE_CLIENT.clientId,
        GITHUB_APP_CLIENT_SECRET: FAKE_CLIENT.clientSecret,
        GITHUB_APP_SLUG: E2E_APP_SLUG,
        SESSION_SECRET: E2E_SESSION_SECRET,
        GITHUB_FAKE_ORIGIN: `http://127.0.0.1:${PORTS.github}`,
      },
      reuseExistingServer: false,
    },
  ],
});
