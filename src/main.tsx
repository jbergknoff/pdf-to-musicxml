import { render } from "preact";
import { App } from "./App";
import { createOmrClient } from "./worker/omr-client";

// Entry point: start the OMR worker (it owns inference + model loading so the
// pipeline never blocks the UI) and mount the app once it reports its provider.
// The page must be cross-origin isolated for ORT Web's threaded WASM backend
// (see scripts/serve.ts).
async function start() {
  const root = document.getElementById("app");
  if (root === null) {
    return;
  }
  if (!crossOriginIsolated) {
    render(
      <p>
        This page is not cross-origin isolated; the WASM backend needs COOP/COEP
        headers. See scripts/serve.ts / netlify.toml.
      </p>,
      root,
    );
    return;
  }
  const client = await createOmrClient();
  render(<App client={client} />, root);
}

start();
