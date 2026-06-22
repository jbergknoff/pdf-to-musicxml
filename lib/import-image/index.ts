/**
 * Public API of the import-image OMR pipeline.
 *
 * This is the single entry point the editor (and any other consumer) uses to
 * turn a PDF or raster image of printed sheet music into MusicXML. Everything
 * runs locally in the browser: decoding happens on the main thread (pdf.js /
 * canvas are DOM-bound), and all inference runs in the OMR worker.
 *
 * The heavy lifting — segmentation, staff detection, TrOMR transcription — lives
 * behind `createOmrClient`, which spins up `omr.worker.js`. The build copies that
 * worker bundle, the ORT WASM assets, and the pdf.js worker to the site root, and
 * the page must be cross-origin isolated (COOP/COEP) for ORT's threaded WASM
 * backend; see the root build script and netlify.toml.
 */
import { buildScore } from "./lib/assembly/musicxml-builder";
import { groupSystems } from "./lib/staves/system-grouping";
import type { ScoreSystem } from "./lib/types";
import { decodeFilePages, isPdf } from "./src/input/decode";
import { createOmrClient } from "./src/worker/omr-client";
import type {
  BackendChoice,
  ProgressUpdate,
  StaffDetectionMode,
} from "./src/worker/protocol";

export { isPdf };
export type { BackendChoice, ProgressUpdate, StaffDetectionMode };

export interface ImageImporterOptions {
  /** Inference provider; "auto" (default) picks WebGPU when an adapter works. */
  backend?: BackendChoice;
  /**
   * How to locate stafflines; "classical" (default) is the fast, weight-free
   * Otsu + run-length path for born-digital scores, falling back to the model
   * when it finds no staves. "model" always uses the oemer staff mask.
   */
  staffDetection?: StaffDetectionMode;
}

/**
 * A reusable importer. Creating it loads the inference backend (and, on first
 * import, the model weights) once and keeps the worker alive across imports, so
 * prefer this over {@link imageToMusicXml} when importing more than one file.
 */
export interface ImageImporter {
  /** Inference provider the worker resolved (e.g. "webgpu" | "wasm"). */
  readonly provider: string;
  /** Recognize one PDF/image file and return the recovered MusicXML string. */
  importFile(
    file: File,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<string>;
  /** Terminate the underlying worker. */
  dispose(): void;
}

/**
 * Create a reusable {@link ImageImporter}. Resolves once the worker has reported
 * its inference provider, so the caller can show it before the first import.
 */
export async function createImageImporter(
  options: ImageImporterOptions = {},
): Promise<ImageImporter> {
  const client = await createOmrClient({
    backend: options.backend ?? "auto",
    staffDetection: options.staffDetection ?? "classical",
  });
  return {
    provider: client.provider,
    async importFile(file, onProgress) {
      // Decode on the main thread (pdf.js / createImageBitmap are DOM-bound),
      // then hand each full-resolution page raster to the worker in turn. A
      // multi-page PDF yields one raster per page; a raster image yields one.
      const pages = await decodeFilePages(file);
      // Each page contributes its systems (a treble-over-bass pair becomes one
      // grand-staff system) in reading order; concatenating across pages gives
      // the part's full timeline.
      const systems: ScoreSystem[] = [];
      let recognizedNotes = 0;
      for (let page = 0; page < pages.length; page++) {
        const result = await client.process(pages[page], (update) => {
          onProgress?.(
            pages.length > 1
              ? { ...update, page, pageCount: pages.length }
              : update,
          );
        });
        systems.push(...groupSystems(result.transcriptions, result.braces));
        for (const transcription of result.transcriptions) {
          recognizedNotes += transcription.notes.length;
        }
      }
      // Preserve the worker's empty-string contract (nothing recognized) so
      // callers can tell a failed import from a one-rest document.
      return recognizedNotes === 0 ? "" : buildScore(systems);
    },
    dispose() {
      client.dispose();
    },
  };
}

/**
 * One-shot convenience: recognize a single file and return its MusicXML, tearing
 * the worker down afterward. For repeated imports use {@link createImageImporter}
 * so the models load only once.
 */
export async function imageToMusicXml(
  file: File,
  options: ImageImporterOptions & {
    onProgress?: (update: ProgressUpdate) => void;
  } = {},
): Promise<string> {
  const importer = await createImageImporter({
    backend: options.backend,
    staffDetection: options.staffDetection,
  });
  try {
    return await importer.importFile(file, options.onProgress);
  } finally {
    importer.dispose();
  }
}
