import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  type SegmentationModels,
  segment,
} from "../../lib/segmentation/segment";
import { detectStaves } from "../../lib/staves/detect-staves";
import { loadSegmentationModels } from "../models/registry";
import { createWebBackend } from "../runtime/web-backend";
import type { WorkerInbound, WorkerOutbound } from "./protocol";

/**
 * OMR worker: owns the inference backend, the model weights, and the heavy
 * segmentation + staff-detection pass so they run off the main thread. It
 * reports its provider as soon as the backend resolves (before any file is
 * dropped), then processes one decoded page per `process` request, streaming
 * progress and posting the masks + staff structure back.
 */

// The dedicated-worker globals aren't in this project's TS lib set; describe
// just the slice we use rather than pulling in (and clashing with) the DOM lib.
interface WorkerScope {
  postMessage(message: WorkerOutbound, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerInbound>) => void,
  ): void;
}
const workerScope = self as unknown as WorkerScope;

function post(message: WorkerOutbound, transfer?: Transferable[]): void {
  workerScope.postMessage(message, transfer);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The backend and models are resolved once and reused across requests.
let backendPromise: Promise<InferenceBackend> | null = null;
let modelsPromise: Promise<SegmentationModels> | null = null;

function getBackend(): Promise<InferenceBackend> {
  if (backendPromise === null) {
    backendPromise = createWebBackend();
  }
  return backendPromise;
}

function getModels(
  backend: InferenceBackend,
  requestId: number,
): Promise<SegmentationModels> {
  if (modelsPromise === null) {
    // Reset on failure so a later request can retry the download.
    modelsPromise = loadSegmentationModels(backend, {
      onAssetLoading: (entry) => {
        post({
          type: "progress",
          requestId,
          phase: "loading-models",
          fraction: 0,
          detail: entry.fileName,
        });
      },
    }).catch((error) => {
      modelsPromise = null;
      throw error;
    });
  }
  return modelsPromise;
}

async function process(requestId: number, image: WorkerInbound["image"]) {
  const backend = await getBackend();
  const models = await getModels(backend, requestId);

  const masks = await segment(image, models, {
    onProgress: (fraction) => {
      post({ type: "progress", requestId, phase: "segmenting", fraction });
    },
  });

  post({ type: "progress", requestId, phase: "detecting-staves", fraction: 1 });
  const staves = detectStaves(masks.staff);

  // Transfer the mask buffers (~4 MB each) rather than copying them back.
  post({ type: "result", requestId, masks, staves }, [
    masks.staff.data.buffer,
    masks.symbols.data.buffer,
    masks.stemsRests.data.buffer,
    masks.noteheads.data.buffer,
    masks.clefsKeys.data.buffer,
  ]);
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type !== "process") {
    return;
  }
  process(request.requestId, request.image).catch((error) => {
    post({
      type: "error",
      requestId: request.requestId,
      message: messageOf(error),
    });
  });
});

// Resolve the backend up front so the UI can show the provider immediately.
getBackend().then((backend) => {
  post({ type: "ready", provider: backend.provider });
});
