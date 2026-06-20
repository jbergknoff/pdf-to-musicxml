import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
  Transcription,
} from "../../lib/types";
import type {
  OmrConfig,
  ProgressUpdate,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol";

/**
 * Main-thread handle to the OMR worker. {@link createOmrClient} spins the
 * worker up and resolves once it reports its inference provider; the returned
 * client runs the segmentation + staff-detection pipeline off the main thread,
 * so a long WASM segmentation never freezes the UI.
 */

export interface OmrResult {
  masks: SegmentationMasks;
  staves: StaffStructure;
  musicXml: string;
  transcriptions: Transcription[];
}

export interface OmrClient {
  /** Inference provider the worker resolved (e.g. "webgpu" | "wasm"). */
  readonly provider: string;
  /** Run the pipeline on one decoded page, streaming progress. */
  process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult>;
  /** Terminate the worker (used when the config changes and we recreate it). */
  dispose(): void;
}

interface PendingJob {
  resolve(result: OmrResult): void;
  reject(error: Error): void;
  onProgress(update: ProgressUpdate): void;
}

export function createOmrClient(config: OmrConfig): Promise<OmrClient> {
  // Built as its own entry point to dist/omr.worker.js (see scripts/build.ts).
  const worker = new Worker("/omr.worker.js", { type: "module" });
  const jobs = new Map<number, PendingJob>();
  let nextRequestId = 0;

  // Configure the backend before anything else; the worker defers resolving its
  // inference provider until this arrives, then reports "ready".
  worker.postMessage({ type: "config", ...config } satisfies WorkerInbound);

  function dispose() {
    worker.terminate();
    for (const job of jobs.values()) {
      job.reject(new Error("Inference worker was disposed"));
    }
    jobs.clear();
  }

  function process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult> {
    const requestId = nextRequestId++;
    return new Promise<OmrResult>((resolve, reject) => {
      jobs.set(requestId, { resolve, reject, onProgress });
      const request: WorkerInbound = { type: "process", requestId, image };
      // Transfer the raster buffer (full-resolution, so potentially tens of MB)
      // rather than structured-cloning it. The caller does not reuse the image
      // after handing it off.
      worker.postMessage(request, [image.data.buffer]);
    });
  }

  return new Promise<OmrClient>((resolveClient) => {
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      switch (message.type) {
        case "ready": {
          resolveClient({ provider: message.provider, process, dispose });
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
          job?.resolve({
            masks: message.masks,
            staves: message.staves,
            musicXml: message.musicXml,
            transcriptions: message.transcriptions,
          });
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
