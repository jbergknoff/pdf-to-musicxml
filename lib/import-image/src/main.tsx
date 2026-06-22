import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { createOmrClient, type OmrClient } from "./worker/omr-client";
import type { OmrConfig } from "./worker/protocol";

// Entry point: own the inference worker's lifecycle so the UI can pick the
// backend. The page must be cross-origin isolated for ORT Web's threaded WASM
// backend (see scripts/serve.ts).

const DEFAULT_CONFIG: OmrConfig = {
  backend: "auto",
  staffDetection: "classical",
};

/**
 * Owns the OMR config and the worker it drives. Changing the config recreates
 * the worker (the backend/profiling can only be chosen before its sessions are
 * built), so the client is null while a fresh worker spins up.
 */
function Root() {
  const [config, setConfig] = useState<OmrConfig>(DEFAULT_CONFIG);
  const [client, setClient] = useState<OmrClient | null>(null);

  useEffect(() => {
    let disposed = false;
    setClient(null);
    const pending = createOmrClient(config);
    pending.then((next) => {
      if (disposed) {
        next.dispose();
        return;
      }
      setClient(next);
    });
    return () => {
      disposed = true;
      pending.then((next) => next.dispose());
    };
  }, [config]);

  return <App client={client} config={config} onConfigChange={setConfig} />;
}

function start() {
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
  render(<Root />, root);
}

start();
