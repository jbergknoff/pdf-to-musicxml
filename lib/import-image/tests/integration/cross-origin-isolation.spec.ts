import { expect, test } from "@playwright/test";

// The app only mounts when the page is cross-origin isolated (so ORT Web's
// threaded WASM backend can use SharedArrayBuffer) and an execution provider
// resolves. WebGPU is usually absent in headless CI, so we accept the wasm
// fallback. This exercises the page shell only — it does not load the ~109 MB
// model weights or run inference.
test("cross-origin isolated page mounts the app with an inference provider", async ({
  page,
}) => {
  await page.goto("/");
  const app = page.locator("#app");
  // The header's inference settings report the resolved provider once the
  // worker is configured and ready ("running on webgpu" / "running on wasm").
  await expect(app).toContainText(/running on (webgpu|wasm)/);
  await expect(app).toContainText("Drop a PDF or image");
});
