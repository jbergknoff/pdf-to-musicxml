import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/integration",
  // The OMR end-to-end tests have their own config (playwright.omr.config.ts):
  // they run inference in Node and need no static server, so keep them out of
  // this (cross-origin-isolation page) run.
  testIgnore: "**/import-image.spec.ts",
  outputDir: "tests/integration/results",
  use: {
    // BASE_URL is set to http://server:3456 inside Docker compose; falls back
    // to localhost for any direct (non-Docker) invocation.
    baseURL: process.env.BASE_URL ?? "http://localhost:3456",
  },
  // When BASE_URL is not provided (direct / non-Docker run), start the Bun
  // static server automatically so tests work without any manual setup.
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "bun scripts/serve.ts",
        url: "http://localhost:3456",
        reuseExistingServer: true,
      },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
