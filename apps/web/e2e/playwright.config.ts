import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the production build (`next build` first; turbo
// does it in CI). They catch what unit tests can't: the CSP actually letting
// hydration run, the fonts and tokens loading, cookies across reloads.

const PORT = 3107;

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "../dist/e2e-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../dist/e2e-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `pnpm exec next start --hostname 127.0.0.1 --port ${PORT}`,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: `http://127.0.0.1:${PORT}/icon.svg`,
    reuseExistingServer: false,
  },
});
