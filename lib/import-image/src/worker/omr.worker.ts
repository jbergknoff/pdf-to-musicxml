import { MODEL_MANIFEST } from "../../lib/models/manifest";
import { resizeToPixelBudget } from "../../lib/input/preprocess";
import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  type SegmentationModels,
  segment,
} from "../../lib/segmentation/segment";
import { detectStaves } from "../../lib/staves/detect-staves";
import type { RgbaImage, Staff } from "../../lib/types";
import { buildMusicXML } from "../../lib/assembly/musicxml-builder";
import { transcribeStaves } from "../../lib/transcription/transcribe";
import type { TrOMRSessions } from "../../lib/transcription/tromr-session";
import { loadSegmentationModels, loadTrOMRModels } from "../models/registry";
import { createWebBackend } from "../runtime/web-backend";
import type {
  OmrConfig,
  ProcessRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol";

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

// The served weights are optimized with a fixed batch dimension baked into the
// graph (scripts/optimize-models.py — see docs/model-optimization-plan.md), so
// every inference must feed exactly that many tiles. Both models are frozen at
// batch 1 (manifest `inputShape[0]`), which is also the safest batch for both
// backends: one tile per dispatch never approaches ORT-wasm's 32-bit byte-size
// limit nor the oversized-dispatch that crashed the WebGPU GPU process, and it
// keeps the WebGPU pipeline cache to one compiled kernel per op. Batch size was
// never the perf lever anyway (4 vs 8 timed identically) — the fixed-shape fold
// removing the per-tile GPU<->CPU syncs is what this optimization targets.
const FIXED_BATCH_SIZE = MODEL_MANIFEST.staffSymbol.inputShape[0];

// The backend and models are resolved once (after the config message arrives)
// and reused across requests. Changing the config recreates the whole worker,
// so it's resolved here exactly once per worker lifetime.
let backendPromise: Promise<InferenceBackend> | null = null;
let modelsPromise: Promise<SegmentationModels> | null = null;
let tromrPromise: Promise<TrOMRSessions> | null = null;

function getBackend(config: OmrConfig): Promise<InferenceBackend> {
  if (backendPromise === null) {
    backendPromise = createWebBackend({
      forcedProvider: config.backend === "auto" ? undefined : config.backend,
    });
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

function getTrOMR(
  backend: InferenceBackend,
  requestId: number,
): Promise<TrOMRSessions> {
  if (tromrPromise === null) {
    tromrPromise = loadTrOMRModels(backend, {
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
      tromrPromise = null;
      throw error;
    });
  }
  return tromrPromise;
}

/**
 * Scale a detected staff from segmentation-image coordinates into the
 * full-resolution image's coordinates. Horizontal extents scale by the width
 * ratio; row centers and the unit size (both vertical) by the height ratio.
 */
function scaleStaff(staff: Staff, scaleX: number, scaleY: number): Staff {
  return {
    lines: staff.lines.map((line) => line * scaleY),
    unitSize: staff.unitSize * scaleY,
    left: Math.round(staff.left * scaleX),
    right: Math.round(staff.right * scaleX),
  };
}

async function process(
  config: OmrConfig,
  requestId: number,
  image: ProcessRequest["image"],
) {
  const backend = await getBackend(config);
  const models = await getModels(backend, requestId);

  // Segmentation runs on a downscaled copy for speed (the pixel budget is the
  // main speed/accuracy knob), but TrOMR transcription crops from the full
  // resolution: the transformer was trained on full-resolution staves, and
  // shrinking them blurs noteheads and stafflines together. Detected staff
  // coordinates live in the segmentation image's space and are scaled up to the
  // full image before cropping.
  const segImage: RgbaImage = resizeToPixelBudget(image);
  console.info(
    `[omr] input: ${image.width}×${image.height} (${((image.width * image.height) / 1e6).toFixed(1)} Mpx), ` +
      `seg: ${segImage.width}×${segImage.height}`,
  );

  // The optimized weights bake a fixed batch into the graph, so the batch is
  // dictated by the weights (not the provider): feed exactly FIXED_BATCH_SIZE
  // tiles per inference.
  const batchSize = FIXED_BATCH_SIZE;

  // Lightweight perf instrumentation: the segmentation pass is the dominant
  // cost, so log the page size, provider, and wall-clock per phase to find the
  // bottleneck without a profiler.
  const segmentStart = performance.now();
  const masks = await segment(segImage, models, {
    batchSize,
    onProgress: (fraction) => {
      post({ type: "progress", requestId, phase: "segmenting", fraction });
    },
  });
  const segmentMs = performance.now() - segmentStart;

  post({ type: "progress", requestId, phase: "detecting-staves", fraction: 1 });
  const stavesStart = performance.now();
  const staves = detectStaves(masks.staff);
  const stavesMs = performance.now() - stavesStart;

  // Transcribe each detected staff with TrOMR, cropping from the full image.
  const scaleX = image.width / segImage.width;
  const scaleY = image.height / segImage.height;
  const fullResStaves = staves.staves.map((staff) =>
    scaleStaff(staff, scaleX, scaleY),
  );

  let musicXml = "";
  let transcriptions: import("../../lib/types").Transcription[] = [];
  if (staves.staves.length > 0) {
    const tromrSessions = await getTrOMR(backend, requestId);
    post({ type: "progress", requestId, phase: "transcribing", fraction: 0 });
    const transcribeStart = performance.now();
    transcriptions = await transcribeStaves(
      tromrSessions,
      image,
      fullResStaves,
      {
        onProgress: (done, total) => {
          post({
            type: "progress",
            requestId,
            phase: "transcribing",
            fraction: done / total,
          });
        },
      },
    );
    const allNotes = transcriptions.flatMap((t) => t.notes);
    musicXml = buildMusicXML(allNotes);
    console.info(
      `[omr] ${image.width}x${image.height} via ${backend.provider}: ` +
        `segment ${Math.round(segmentMs)}ms, ` +
        `detect-staves ${Math.round(stavesMs)}ms, ` +
        `transcribe ${Math.round(performance.now() - transcribeStart)}ms`,
    );
  } else {
    console.info(
      `[omr] ${image.width}x${image.height} via ${backend.provider}: ` +
        `segment ${Math.round(segmentMs)}ms, ` +
        `detect-staves ${Math.round(stavesMs)}ms (no staves detected)`,
    );
  }

  // Transfer the mask buffers (~4 MB each) rather than copying them back.
  post({ type: "result", requestId, masks, staves, musicXml, transcriptions }, [
    masks.staff.data.buffer,
    masks.symbols.data.buffer,
    masks.stemsRests.data.buffer,
    masks.noteheads.data.buffer,
    masks.clefsKeys.data.buffer,
  ]);
}

// The config message arrives once at startup, before any process request, and
// fixes the backend for this worker's lifetime.
let config: OmrConfig | null = null;

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "config") {
    config = { backend: request.backend };
    // Resolve the backend now so the UI can show the provider before any drop.
    getBackend(config).then((backend) => {
      post({ type: "ready", provider: backend.provider });
    });
    return;
  }
  if (request.type !== "process") {
    return;
  }
  if (config === null) {
    post({
      type: "error",
      requestId: request.requestId,
      message: "Received a process request before the worker was configured",
    });
    return;
  }
  process(config, request.requestId, request.image).catch((error) => {
    post({
      type: "error",
      requestId: request.requestId,
      message: messageOf(error),
    });
  });
});
