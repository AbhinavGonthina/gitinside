import { defineConfig, devices } from "@playwright/test";

// Visual regression for every Storybook story in dark and light (TESTING.md).
// Baselines are captured only in Linux CI, in the Playwright Docker image
// pinned to the same version as @playwright/test, so fonts rasterize the same
// way on every run. Elsewhere the spec skips itself. Run after
// `build-storybook`; update baselines with the "Visual baselines" workflow.

const PORT = 6107;

export default defineConfig({
  testDir: ".",
  testMatch: "stories.visual.ts",
  snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
  outputDir: "../dist/visual-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../dist/visual-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" },
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `node serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: false,
  },
});
