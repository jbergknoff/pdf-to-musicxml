import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  type SegmentationModels,
  segment,
} from "../../lib/segmentation/segment";
import { detectStaves } from "../../lib/staves/detect-staves";
import { loadSegmentationModels } from "../models/registry";
import { createWebBackend, type ForcedProvider } from "../runtime/web-backend";
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
  location: { search: string };
  postMessage(message: WorkerOutbound, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerInbound>) => void,
  ): void;
}
const workerScope = self as unknown as WorkerScope;

// The page's `?backend=` override doesn't reach the worker on its own, so the
// client forwards it on the worker URL (omr-client.ts); read it back here to
// force the inference provider for A/B timing of wasm vs. webgpu.
function forcedProvider(): ForcedProvider | undefined {
  const value = new URLSearchParams(workerScope.location.search).get("backend");
  return value === "wasm" || value === "webgpu" ? value : undefined;
}

function post(message: WorkerOutbound, transfer?: Transferable[]): void {
  workerScope.postMessage(message, transfer);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Small enough that the 288² model's per-run conv intermediates stay within
// ORT-wasm's 32-bit byte-size limits (batch 16 overflowed); large enough to
// still amortize a little per-call overhead.
const WASM_BATCH_SIZE = 4;

// WebGPU needs its own cap. At batch 16 the 288² model issues a single conv
// dispatch large enough to either exceed the GPU's max buffer/binding size or
// run long enough to trip the driver's watchdog (TDR) — both of which kill the
// GPU process and take the whole browser down with it (observed: a ~30s grind,
// then a full Chrome crash, once inference reaches the heavier 2nd model). This
// is a device-level failure, not a JS exception, so it can't be caught and
// recovered from — it can only be avoided by keeping each dispatch small. Batch
// 4 was stable but very slow (~3.7 min/page); 8 trades toward throughput while
// staying well under the 16 that crashed. Raise further only with care — the
// downside of overshooting is a browser crash, not a catchable error.
const WEBGPU_BATCH_SIZE = 8;

// The backend and models are resolved once and reused across requests.
let backendPromise: Promise<InferenceBackend> | null = null;
let modelsPromise: Promise<SegmentationModels> | null = null;

function getBackend(): Promise<InferenceBackend> {
  if (backendPromise === null) {
    backendPromise = createWebBackend({ forcedProvider: forcedProvider() });
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

  // Both backends need a bounded batch, for different reasons (see the two
  // constants): ORT-wasm is 32-bit and overflows OrtRun's byte-size math at the
  // default batch, while WebGPU crashes the GPU process on an oversized single
  // dispatch. Neither benefits enough from large batches to justify the risk.
  const batchSize =
    backend.provider === "wasm" ? WASM_BATCH_SIZE : WEBGPU_BATCH_SIZE;

  // Lightweight perf instrumentation: the segmentation pass is the dominant
  // cost, so log the page size, provider, and wall-clock per phase to find the
  // bottleneck without a profiler.
  const segmentStart = performance.now();
  const masks = await segment(image, models, {
    batchSize,
    onProgress: (fraction) => {
      post({ type: "progress", requestId, phase: "segmenting", fraction });
    },
  });
  const segmentMs = performance.now() - segmentStart;

  post({ type: "progress", requestId, phase: "detecting-staves", fraction: 1 });
  const stavesStart = performance.now();
  const staves = detectStaves(masks.staff);
  console.info(
    `[omr] ${image.width}x${image.height} via ${backend.provider}: ` +
      `segment ${Math.round(segmentMs)}ms, ` +
      `detect-staves ${Math.round(performance.now() - stavesStart)}ms`,
  );

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
