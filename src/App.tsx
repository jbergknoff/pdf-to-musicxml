import { useState } from "preact/hooks";
import type { InferenceBackend } from "../lib/runtime/inference-backend";
import { resizeToPixelBudget } from "../lib/input/preprocess";
import { segment } from "../lib/segmentation/segment";
import type { RgbaImage, SegmentationMasks } from "../lib/types";
import { FileDrop } from "./components/FileDrop";
import { SegmentationView } from "./components/SegmentationView";
import { decodeFile } from "./input/decode";
import { loadSegmentationModels } from "./models/registry";

/**
 * Phase 1 app: drop a score, run the two oemer segmentation UNets in the
 * browser, and overlay the detected stafflines and symbols on the page.
 */

interface AppProps {
  backend: InferenceBackend;
}

interface Result {
  image: RgbaImage;
  masks: SegmentationMasks;
}

export function App({ backend }: AppProps) {
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

      setStatus("Loading segmentation models…");
      const models = await loadSegmentationModels(backend, {
        onAssetLoading: (entry) => setStatus(`Loading ${entry.fileName}…`),
      });

      // On the WASM backend segmentation runs hundreds of tiles on the CPU and
      // can take a while; show the stage up front so it doesn't look stuck, then
      // stream per-batch progress.
      const slow = backend.provider !== "webgpu";
      setStatus(`Segmenting…${slow ? " (this can take a minute on CPU)" : ""}`);
      const masks = await segment(image, models, {
        onProgress: (fraction) =>
          setStatus(`Segmenting… ${Math.round(fraction * 100)}%`),
      });

      setStatus(null);
      setResult({ image, masks });
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
        <p class="app__provider">Inference provider: {backend.provider}</p>
      </header>

      <FileDrop onFile={handleFile} disabled={busy} />

      {status !== null ? <p class="app__status">{status}</p> : null}
      {error !== null ? <p class="app__error">Error: {error}</p> : null}

      {result !== null ? (
        <SegmentationView image={result.image} masks={result.masks} />
      ) : null}
    </main>
  );
}
