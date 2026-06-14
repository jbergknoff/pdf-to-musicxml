import { render } from "preact";
import { createWebBackend } from "./runtime/web-backend";

// Phase 0 diagnostic page. Acceptance: crossOriginIsolated is true, WebGPU is
// available (Chrome/Edge), and the backend resolves a provider (webgpu, or a
// clean fallback to wasm) with no console errors loading WASM from /ort/.
async function App() {
  const backend = await createWebBackend();
  return (
    <pre>
      crossOriginIsolated: {String(crossOriginIsolated)}
      {"\n"}
      WebGPU available: {String("gpu" in navigator)}
      {"\n"}
      selected provider: {backend.provider}
    </pre>
  );
}

App().then((node) => {
  const root = document.getElementById("app");
  if (root) {
    render(node, root);
  }
});
