import { useState } from "preact/hooks";
import { resizeToPixelBudget } from "../lib/input/preprocess";
import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../lib/types";
import { FileDrop } from "./components/FileDrop";
import { SegmentationView } from "./components/SegmentationView";
import { decodeFile } from "./input/decode";
import type { OmrClient } from "./worker/omr-client";
import type { ProgressUpdate } from "./worker/protocol";

/**
 * Phases 1–2 app: drop a score, run the two oemer segmentation UNets and the
 * staff-structure detection in a worker, then overlay the detected stafflines,
 * symbols, and five-line staves on the page. Decoding stays on the main thread
 * (pdf.js / canvas are DOM-bound); the heavy inference runs off it.
 */

interface AppProps {
  client: OmrClient;
}

interface Result {
  image: RgbaImage;
  masks: SegmentationMasks;
  staves: StaffStructure;
}

/** Compose the status line from a worker progress update. */
function describeProgress(update: ProgressUpdate, slow: boolean): string {
  switch (update.phase) {
    case "loading-models": {
      return update.detail !== undefined
        ? `Loading ${update.detail}…`
        : "Loading segmentation models…";
    }
    case "segmenting": {
      // On the WASM backend segmentation runs hundreds of tiles on the CPU and
      // can take a while; flag that so it doesn't look stuck.
      const hint = slow ? " (this can take a minute on CPU)" : "";
      return `Segmenting… ${Math.round(update.fraction * 100)}%${hint}`;
    }
    case "detecting-staves": {
      return "Detecting staves…";
    }
  }
}

export function App({ client }: AppProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStatus(`Decoding ${file.name}…`);
      const decoded = await decodeFile(file);
      const image = resizeToPixelBudget(decoded);

      const slow = client.provider !== "webgpu";
      const { masks, staves } = await client.process(image, (update) => {
        setStatus(describeProgress(update, slow));
      });

      setStatus(null);
      setResult({ image, masks, staves });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="app">
      <header class="app__header">
        <h1>pdf-to-musicxml</h1>
        <p class="app__provider">Inference provider: {client.provider}</p>
      </header>

      <FileDrop onFile={handleFile} disabled={busy} />

      {status !== null ? (
        <p class="app__status">
          {busy ? <span class="spinner" aria-hidden="true" /> : null}
          {status}
        </p>
      ) : null}
      {error !== null ? <p class="app__error">Error: {error}</p> : null}

      {result !== null ? (
        <SegmentationView
          image={result.image}
          masks={result.masks}
          staves={result.staves}
        />
      ) : null}
    </main>
  );
}
