import { defineConfig } from "@playwright/test";

/**
 * Config for the end-to-end OMR integration tests (import-image.spec.ts).
 *
 * Separate from playwright.config.ts (the cross-origin-isolation page check):
 * these tests run the real OMR pipeline in Node (onnxruntime-node) and only use
 * the browser to render the recovered MusicXML with OSMD for a screenshot. They
 * need no static server (OSMD is loaded via page.setContent), so there is no
 * webServer/baseURL here.
 *
 * Single worker, serial: the ~109 MB of model weights and four inference
 * sessions are loaded once in beforeAll and shared across fixtures.
 */
export default defineConfig({
  testDir: "tests/integration",
  testMatch: "**/import-image.spec.ts",
  outputDir: "tests/integration/results",
  // All snapshots (MusicXML + screenshots) live alongside the spec, without a
  // platform suffix: the pipeline runs in the pinned Playwright Linux image both
  // in CI and locally, so a single committed baseline is correct everywhere.
  snapshotPathTemplate: "{testDir}/__snapshots__/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  // Slow, deterministic inference — never retry (a retry would just be slow, and
  // any nondeterminism should fail loudly rather than be papered over).
  retries: 0,
  reporter: "list",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
