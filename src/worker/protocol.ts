import type { Mask, RgbaImage, StaffStructure } from "../../lib/types";

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
  | "detecting-staves";

export interface ProgressUpdate {
  phase: ProgressPhase;
  /** Fraction complete within the phase, in [0, 1]. */
  fraction: number;
  /** Extra context for the phase (e.g. the model file being loaded). */
  detail?: string;
}

/**
 * Which model a worker owns. The two segmentation models are independent, so
 * each runs in its own worker (its own ORT instance / WebGPU device) and the
 * main thread merges their masks — ORT-web can't run two sessions concurrently
 * on one device, so separate workers is how the models actually overlap.
 */
export type WorkerRole = "staffSymbol" | "symbolDetail";

/** Posted once, after the worker resolves its inference backend. */
export interface ReadyMessage {
  type: "ready";
  role: WorkerRole;
  provider: string;
}

export interface ProgressMessage extends ProgressUpdate {
  type: "progress";
  role: WorkerRole;
  requestId: number;
}

/** The `unet_big` worker's masks plus the staff structure it derived. */
export interface StaffSymbolResultMessage {
  type: "result";
  role: "staffSymbol";
  requestId: number;
  width: number;
  height: number;
  staff: Mask;
  symbols: Mask;
  staves: StaffStructure;
}

/** The `seg_net` worker's three symbol-class masks. */
export interface SymbolDetailResultMessage {
  type: "result";
  role: "symbolDetail";
  requestId: number;
  width: number;
  height: number;
  stemsRests: Mask;
  noteheads: Mask;
  clefsKeys: Mask;
}

export type ResultMessage =
  | StaffSymbolResultMessage
  | SymbolDetailResultMessage;

export interface ErrorMessage {
  type: "error";
  role: WorkerRole;
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
 *
 * `role` assigns the worker its model. `wasmThreads` caps the worker's WASM
 * thread pool: with two workers sharing one CPU, each takes half the cores so
 * the threaded WASM path doesn't oversubscribe (ignored on the WebGPU path).
 */
export interface ConfigRequest extends OmrConfig {
  type: "config";
  role: WorkerRole;
  wasmThreads?: number;
}

/** Everything the main thread sends to the worker. */
export type WorkerInbound = ProcessRequest | ConfigRequest;
