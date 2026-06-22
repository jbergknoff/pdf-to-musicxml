import { MODEL_MANIFEST } from "../../lib/models/manifest";
import {
  resizeToPixelBudget,
  SEGMENTATION_PIXEL_BUDGET,
} from "../../lib/input/preprocess";
import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  type SegmentationModels,
  segment,
} from "../../lib/segmentation/segment";
import { classicalStaffMask } from "../../lib/staves/classical-staff-mask";
import { detectStaves } from "../../lib/staves/detect-staves";
import { detectBraces } from "../../lib/staves/brace-detection";
import type {
  Mask,
  RgbaImage,
  SegmentationMasks,
  Staff,
  StaffStructure,
  Transcription,
} from "../../lib/types";
import { buildScore } from "../../lib/assembly/musicxml-builder";
import { groupSystems } from "../../lib/staves/system-grouping";
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

/** Set-pixel count and percentage of a binary mask, for debug logging. */
function maskCoverage(mask: Mask): string {
  let count = 0;
  for (let index = 0; index < mask.data.length; index++) {
    count += mask.data[index];
  }
  const percent = ((count / mask.data.length) * 100).toFixed(2);
  return `${count}px (${percent}%)`;
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

/** An all-zero mask of the given size (a placeholder symbol layer). */
function emptyMask(width: number, height: number): Mask {
  return { data: new Uint8Array(width * height), width, height };
}

/**
 * Wrap a classically-derived staff mask in the {@link SegmentationMasks} shape
 * the result message carries. The symbol layers the model would supply are not
 * computed on the classical path (it never runs `seg_net`), so they are empty —
 * the page overlay simply has nothing to draw for them.
 */
function masksFromStaff(staffMask: Mask): SegmentationMasks {
  const { width, height } = staffMask;
  return {
    width,
    height,
    staff: staffMask,
    symbols: emptyMask(width, height),
    stemsRests: emptyMask(width, height),
    noteheads: emptyMask(width, height),
    clefsKeys: emptyMask(width, height),
  };
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

  // Segmentation runs on a downscaled copy for speed (the pixel budget is the
  // main speed/accuracy knob), but TrOMR transcription crops from the full
  // resolution: the transformer was trained on full-resolution staves, and
  // shrinking them blurs noteheads and stafflines together. Detected staff
  // coordinates live in the segmentation image's space and are scaled up to the
  // full image before cropping.
  //
  // The budget is provider-dependent: WebGPU is fast enough per tile to run at
  // oemer's training resolution (~3 Mpx), which keeps thin stafflines off the
  // argmax decision boundary where the WebGPU EP otherwise diverges from WASM
  // and loses staves; WASM stays at the lower budget to bound its much slower
  // per-tile time.
  const pixelBudget =
    backend.provider === "webgpu"
      ? SEGMENTATION_PIXEL_BUDGET.webgpu
      : SEGMENTATION_PIXEL_BUDGET.wasm;
  const segImage: RgbaImage = resizeToPixelBudget(image, pixelBudget);
  console.info(
    `[omr] input: ${image.width}×${image.height} (${((image.width * image.height) / 1e6).toFixed(1)} Mpx), ` +
      `seg: ${segImage.width}×${segImage.height} ` +
      `(budget ${(pixelBudget / 1e6).toFixed(1)} Mpx, ${backend.provider})`,
  );

  // The optimized weights bake a fixed batch into the graph, so the batch is
  // dictated by the weights (not the provider): feed exactly FIXED_BATCH_SIZE
  // tiles per inference.
  const batchSize = FIXED_BATCH_SIZE;

  // Run the oemer staff/symbol segmentation model over the page, logging its
  // per-class coverage. Loads the ~70 MB unet weights on first use, so it is
  // only invoked when the configured/needed staff-detection path requires it.
  const runModel = async (): Promise<SegmentationMasks> => {
    const models = await getModels(backend, requestId);
    const segmentStart = performance.now();
    const result = await segment(segImage, models, {
      batchSize,
      onProgress: (fraction) => {
        post({ type: "progress", requestId, phase: "segmenting", fraction });
      },
    });
    segmentMs = performance.now() - segmentStart;
    console.info(
      `[omr] oemer masks ${result.width}×${result.height}: ` +
        `staff ${maskCoverage(result.staff)}, symbols ${maskCoverage(result.symbols)}, ` +
        `stems/rests ${maskCoverage(result.stemsRests)}, ` +
        `noteheads ${maskCoverage(result.noteheads)}, ` +
        `clefs/keys ${maskCoverage(result.clefsKeys)}`,
    );
    return result;
  };

  // Locate stafflines. The classical (model-free) path is the default for clean
  // born-digital scores; it skips segmentation entirely, falling back to the
  // model only when it finds no staves. "model" always uses the oemer mask.
  post({ type: "progress", requestId, phase: "detecting-staves", fraction: 1 });
  let masks: SegmentationMasks;
  let staves: StaffStructure;
  let staffMethod: string;
  let segmentMs = 0;
  let stavesMs = 0;
  if (config.staffDetection === "classical") {
    const staffMask = classicalStaffMask(segImage);
    const stavesStart = performance.now();
    staves = detectStaves(staffMask);
    stavesMs = performance.now() - stavesStart;
    if (staves.staves.length > 0) {
      masks = masksFromStaff(staffMask);
      staffMethod = "classical";
    } else {
      masks = await runModel();
      const fallbackStart = performance.now();
      staves = detectStaves(masks.staff);
      stavesMs = performance.now() - fallbackStart;
      staffMethod = "classical→model (no staves found classically)";
    }
  } else {
    masks = await runModel();
    const stavesStart = performance.now();
    staves = detectStaves(masks.staff);
    stavesMs = performance.now() - stavesStart;
    staffMethod = "model";
  }
  console.info(`[omr] staff detection: ${staffMethod}`);

  // Log the detected staff geometry (segmentation-image space): a wrong staff
  // count or unit size is the first suspect for bad crops and transcription.
  console.info(
    `[omr] detected ${staves.staves.length} staves, page unitSize=${staves.unitSize.toFixed(2)}`,
  );
  for (let index = 0; index < staves.staves.length; index++) {
    const staff = staves.staves[index];
    console.info(
      `[omr]   staff ${index + 1}: lines=[${staff.lines
        .map((line) => line.toFixed(1))
        .join(", ")}] unitSize=${staff.unitSize.toFixed(2)} ` +
        `x=[${staff.left}, ${staff.right}]`,
    );
  }

  // Detect grand-staff braces from the left margin of the segmentation image
  // (same coordinate space as the detected staves). These drive system grouping
  // both here and, returned in the result, in the multi-page importer.
  const braces = detectBraces(segImage, staves.staves);
  console.info(`[omr] brace links (adjacent staves): [${braces.join(", ")}]`);

  // Transcribe each detected staff with TrOMR, cropping from the full image.
  const scaleX = image.width / segImage.width;
  const scaleY = image.height / segImage.height;
  const fullResStaves = staves.staves.map((staff) =>
    scaleStaff(staff, scaleX, scaleY),
  );

  let musicXml = "";
  let transcriptions: Transcription[] = [];
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
    // Group staves into systems (brace-linked staves form a grand staff, with a
    // clef fallback) and assemble them into one part, sequential in time.
    musicXml = buildScore(groupSystems(transcriptions, braces));
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
  post(
    {
      type: "result",
      requestId,
      masks,
      staves,
      musicXml,
      transcriptions,
      braces,
    },
    [
      masks.staff.data.buffer,
      masks.symbols.data.buffer,
      masks.stemsRests.data.buffer,
      masks.noteheads.data.buffer,
      masks.clefsKeys.data.buffer,
    ],
  );
}

// The config message arrives once at startup, before any process request, and
// fixes the backend for this worker's lifetime.
let config: OmrConfig | null = null;

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "config") {
    config = {
      backend: request.backend,
      staffDetection: request.staffDetection,
    };
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
