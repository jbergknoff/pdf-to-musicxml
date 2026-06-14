import { expect, test } from "@playwright/test";

// Phase 0 acceptance, automated: the page must be cross-origin isolated (so ORT
// Web's threaded WASM backend can use SharedArrayBuffer) and the backend must
// resolve an execution provider. WebGPU is usually absent in headless CI, so we
// accept either webgpu or the wasm fallback.
test("page is cross-origin isolated and reports an inference provider", async ({
  page,
}) => {
  await page.goto("/");
  const app = page.locator("#app");
  await expect(app).toContainText("crossOriginIsolated: true");
  await expect(app).toContainText(/selected provider:\s+(webgpu|wasm)/);
});
