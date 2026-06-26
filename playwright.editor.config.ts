import { defineConfig } from "@playwright/test";

// Browser integration tests for the editor's editing flows (select / add /
// delete / undo / view-only). Separate from the OMR Playwright configs under
// lib/import-image/. Builds the editor and serves editor/dist on :3456 (the
// same COOP/COEP static server the app uses) before running.
export default defineConfig({
  testDir: "editor/tests",
  outputDir: "editor/tests/results",
  // No network or weights needed — these flows import .musicxml directly.
  fullyParallel: false,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3456",
    // The editor uses pointer events for selection; trace on first retry helps
    // debugging a failed gesture.
    trace: "on-first-retry",
  },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "bun run scripts/build-editor.ts && bun scripts/serve.ts",
        url: "http://localhost:3456",
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
