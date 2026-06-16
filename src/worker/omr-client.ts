import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../../lib/types";
import type { ProgressUpdate, WorkerInbound, WorkerOutbound } from "./protocol";

/**
 * Main-thread handle to the OMR worker. {@link createOmrClient} spins the
 * worker up and resolves once it reports its inference provider; the returned
 * client runs the segmentation + staff-detection pipeline off the main thread,
 * so a long WASM segmentation never freezes the UI.
 */

export interface OmrResult {
  masks: SegmentationMasks;
  staves: StaffStructure;
}

export interface OmrClient {
  /** Inference provider the worker resolved (e.g. "webgpu" | "wasm"). */
  readonly provider: string;
  /** Run the pipeline on one decoded page, streaming progress. */
  process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult>;
}

interface PendingJob {
  resolve(result: OmrResult): void;
  reject(error: Error): void;
  onProgress(update: ProgressUpdate): void;
}

export function createOmrClient(): Promise<OmrClient> {
  // Built as its own entry point to dist/omr.worker.js (see scripts/build.ts).
  const worker = new Worker("/omr.worker.js", { type: "module" });
  const jobs = new Map<number, PendingJob>();
  let nextRequestId = 0;

  function process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult> {
    const requestId = nextRequestId++;
    return new Promise<OmrResult>((resolve, reject) => {
      jobs.set(requestId, { resolve, reject, onProgress });
      const request: WorkerInbound = { type: "process", requestId, image };
      worker.postMessage(request);
    });
  }

  return new Promise<OmrClient>((resolveClient) => {
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      switch (message.type) {
        case "ready": {
          resolveClient({ provider: message.provider, process });
          break;
        }
        case "progress": {
          jobs.get(message.requestId)?.onProgress({
            phase: message.phase,
            fraction: message.fraction,
            detail: message.detail,
          });
          break;
        }
        case "result": {
          const job = jobs.get(message.requestId);
          jobs.delete(message.requestId);
          job?.resolve({ masks: message.masks, staves: message.staves });
          break;
        }
        case "error": {
          const job = jobs.get(message.requestId);
          jobs.delete(message.requestId);
          job?.reject(new Error(message.message));
          break;
        }
      }
    };
  });
}
