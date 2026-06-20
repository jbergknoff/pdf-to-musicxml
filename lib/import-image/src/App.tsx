import { useState } from "preact/hooks";
import { resizeToPixelBudget } from "../lib/input/preprocess";
import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
  Transcription,
} from "../lib/types";
import { FileDrop } from "./components/FileDrop";
import { InferenceSettings } from "./components/InferenceSettings";
import { ScoreView } from "./components/ScoreView";
import { SegmentationView } from "./components/SegmentationView";
import { TranscriptionDebug } from "./components/TranscriptionDebug";
import { decodeFile } from "./input/decode";
import type { OmrClient } from "./worker/omr-client";
import type { OmrConfig, ProgressUpdate } from "./worker/protocol";

/**
 * Phases 1–3 app: drop a score, run the two oemer segmentation UNets, detect
 * staves, transcribe each staff with TrOMR, and render the recovered MusicXML
 * via OSMD. Decoding stays on the main thread (pdf.js / canvas are DOM-bound);
 * all inference runs off it in the OMR worker.
 */

interface AppProps {
  /** Null while a fresh worker spins up (e.g. after a backend change). */
  client: OmrClient | null;
  config: OmrConfig;
  onConfigChange: (next: OmrConfig) => void;
}

interface Result {
  image: RgbaImage;
  masks: SegmentationMasks;
  staves: StaffStructure;
  musicXml: string;
  transcriptions: Transcription[];
  fileName: string;
}

/** Compose the status line from a worker progress update. */
function describeProgress(update: ProgressUpdate, slow: boolean): string {
  switch (update.phase) {
    case "loading-models": {
      return update.detail !== undefined
        ? `Loading ${update.detail}…`
        : "Loading models…";
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
    case "transcribing": {
      const pct = Math.round(update.fraction * 100);
      return `Transcribing… ${pct}%`;
    }
  }
}

export function App({ client, config, onConfigChange }: AppProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleFile(file: File) {
    if (client === null) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setStatus(`Decoding ${file.name}…`);
      const decoded = await decodeFile(file);
      // The worker segments on its own downscaled copy but transcribes from the
      // full-resolution image, so hand it the full raster. For display and the
      // mask overlay we need the same downscaled image the worker segments —
      // resizeToPixelBudget is deterministic, so this matches the worker's copy.
      const displayImage = resizeToPixelBudget(decoded);

      const slow = client.provider !== "webgpu";
      const { masks, staves, musicXml, transcriptions } = await client.process(
        decoded,
        (update) => {
          setStatus(describeProgress(update, slow));
        },
      );

      setStatus(null);
      // Strip the extension from the original filename for the download suggestion.
      const baseName = file.name.replace(/\.[^.]+$/, "");
      setResult({
        image: displayImage,
        masks,
        staves,
        musicXml,
        transcriptions,
        fileName: `${baseName}.musicxml`,
      });
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
        <InferenceSettings
          config={config}
          provider={client?.provider ?? null}
          disabled={busy}
          onChange={onConfigChange}
        />
      </header>

      <FileDrop onFile={handleFile} disabled={busy || client === null} />

      {status !== null ? (
        <p class="app__status">
          {busy ? <span class="spinner" aria-hidden="true" /> : null}
          {status}
        </p>
      ) : null}
      {error !== null ? <p class="app__error">Error: {error}</p> : null}

      {result !== null ? (
        <>
          <SegmentationView
            image={result.image}
            masks={result.masks}
            staves={result.staves}
          />
          {result.musicXml !== "" ? (
            <ScoreView musicXml={result.musicXml} fileName={result.fileName} />
          ) : null}
          <TranscriptionDebug
            image={result.image}
            staves={result.staves.staves}
            transcriptions={result.transcriptions}
          />
        </>
      ) : null}
    </main>
  );
}
