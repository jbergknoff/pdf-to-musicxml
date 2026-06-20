import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
  Transcription,
} from "../../lib/types";

/**
 * Message protocol between the main thread and the OMR worker
 * (`src/worker/omr.worker.ts`).
 *
 * The worker owns the inference backend, the model weights, and the heavy
 * segmentation + staff-detection pass, so none of that blocks the UI thread.
 * The main thread decodes the file (pdf.js / `createImageBitmap` are
 * DOM-bound), hands the raster over, and renders progress and results.
 */

/** Coarse pipeline phase, so the UI thread composes its own status text. */
export type ProgressPhase =
  | "loading-models"
  | "segmenting"
  | "detecting-staves"
  | "transcribing";

export interface ProgressUpdate {
  phase: ProgressPhase;
  /** Fraction complete within the phase, in [0, 1]. */
  fraction: number;
  /** Extra context for the phase (e.g. the model file being loaded). */
  detail?: string;
  /**
   * 0-based index of the page being recognized, for multi-page PDFs. Set by the
   * importer (the worker processes one page at a time and does not know the page
   * count); absent for single-page inputs.
   */
  page?: number;
  /** Total page count when recognizing a multi-page input; absent otherwise. */
  pageCount?: number;
}

/** Posted once, after the worker resolves its inference backend. */
export interface ReadyMessage {
  type: "ready";
  provider: string;
}

export interface ProgressMessage extends ProgressUpdate {
  type: "progress";
  requestId: number;
}

export interface ResultMessage {
  type: "result";
  requestId: number;
  masks: SegmentationMasks;
  staves: StaffStructure;
  /**
   * MusicXML string for all detected staves (one part per staff in order).
   * Empty string when the TrOMR model is not yet available or no staves were
   * detected.
   */
  musicXml: string;
  /** Per-staff transcription results in the same order as `staves.staves`. */
  transcriptions: Transcription[];
}

export interface ErrorMessage {
  type: "error";
  requestId: number;
  message: string;
}

/** Everything the worker sends back to the main thread. */
export type WorkerOutbound =
  | ReadyMessage
  | ProgressMessage
  | ResultMessage
  | ErrorMessage;

/** Request to run the pipeline on one decoded page. */
export interface ProcessRequest {
  type: "process";
  requestId: number;
  image: RgbaImage;
}

/** Which inference provider to use; "auto" picks WebGPU when an adapter works. */
export type BackendChoice = "auto" | "webgpu" | "wasm";

/** UI-controlled inference options, sent to the worker before it starts up. */
export interface OmrConfig {
  backend: BackendChoice;
}

/**
 * Sent once, right after the worker starts, to configure the backend. The
 * worker defers resolving its inference provider until this arrives, so the UI
 * can pick the backend; changing it later recreates the worker.
 */
export interface ConfigRequest extends OmrConfig {
  type: "config";
}

/** Everything the main thread sends to the worker. */
export type WorkerInbound = ProcessRequest | ConfigRequest;
