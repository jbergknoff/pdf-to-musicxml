import { MODEL_MANIFEST } from "../../lib/models/manifest";
import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  segmentStaffSymbol,
  segmentSymbolDetail,
} from "../../lib/segmentation/segment";
import type { SegmentationModel } from "../../lib/segmentation/unet-session";
import { detectStaves } from "../../lib/staves/detect-staves";
import {
  loadStaffSymbolModel,
  loadSymbolDetailModel,
} from "../models/registry";
import { createWebBackend } from "../runtime/web-backend";
import type {
  ConfigRequest,
  ProcessRequest,
  WorkerInbound,
  WorkerOutbound,
  WorkerRole,
} from "./protocol";

/**
 * OMR worker: owns one segmentation model (its `role`), the inference backend,
 * and the heavy segmentation pass for that model, so it runs off the main
 * thread. The two models run in two of these workers concurrently — separate
 * ORT instances / WebGPU devices — because ORT-web can't run two sessions on one
 * device at once. The `staffSymbol` worker also derives the staff structure (it
 * owns the staff mask); the main thread merges both workers' masks.
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

// The config message (which fixes this worker's role + backend) arrives once at
// startup, before any process request. The backend and model are resolved once
// and reused across requests; changing the config recreates the worker.
let config: ConfigRequest | null = null;
let backendPromise: Promise<InferenceBackend> | null = null;
let modelPromise: Promise<SegmentationModel> | null = null;

function getBackend(settings: ConfigRequest): Promise<InferenceBackend> {
  if (backendPromise === null) {
    backendPromise = createWebBackend({
      forcedProvider:
        settings.backend === "auto" ? undefined : settings.backend,
      wasmThreads: settings.wasmThreads,
    });
  }
  return backendPromise;
}

function getModel(
  backend: InferenceBackend,
  role: WorkerRole,
  requestId: number,
): Promise<SegmentationModel> {
  if (modelPromise === null) {
    const load =
      role === "staffSymbol" ? loadStaffSymbolModel : loadSymbolDetailModel;
    // Reset on failure so a later request can retry the download.
    modelPromise = load(backend, {
      onAssetLoading: (entry) => {
        post({
          type: "progress",
          role,
          requestId,
          phase: "loading-models",
          fraction: 0,
          detail: entry.fileName,
        });
      },
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function process(
  settings: ConfigRequest,
  requestId: number,
  image: ProcessRequest["image"],
) {
  const { role } = settings;
  const backend = await getBackend(settings);
  const model = await getModel(backend, role, requestId);

  const onProgress = (fraction: number) => {
    post({ type: "progress", role, requestId, phase: "segmenting", fraction });
  };
  const start = performance.now();

  if (role === "staffSymbol") {
    const masks = await segmentStaffSymbol(image, model, {
      batchSize: FIXED_BATCH_SIZE,
      onProgress,
    });
    post({
      type: "progress",
      role,
      requestId,
      phase: "detecting-staves",
      fraction: 1,
    });
    const staves = detectStaves(masks.staff);
    console.info(
      `[omr] staff/symbol ${image.width}x${image.height} via ${backend.provider}: ` +
        `${Math.round(performance.now() - start)}ms`,
    );
    post(
      {
        type: "result",
        role,
        requestId,
        width: masks.width,
        height: masks.height,
        staff: masks.staff,
        symbols: masks.symbols,
        staves,
      },
      [masks.staff.data.buffer, masks.symbols.data.buffer],
    );
    return;
  }

  const masks = await segmentSymbolDetail(image, model, {
    batchSize: FIXED_BATCH_SIZE,
    onProgress,
  });
  console.info(
    `[omr] symbol-detail ${image.width}x${image.height} via ${backend.provider}: ` +
      `${Math.round(performance.now() - start)}ms`,
  );
  post(
    {
      type: "result",
      role,
      requestId,
      width: masks.width,
      height: masks.height,
      stemsRests: masks.stemsRests,
      noteheads: masks.noteheads,
      clefsKeys: masks.clefsKeys,
    },
    [
      masks.stemsRests.data.buffer,
      masks.noteheads.data.buffer,
      masks.clefsKeys.data.buffer,
    ],
  );
}

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type === "config") {
    config = request;
    // Resolve the backend now so the UI can show the provider before any drop.
    getBackend(config).then((backend) => {
      post({ type: "ready", role: request.role, provider: backend.provider });
    });
    return;
  }
  if (request.type !== "process") {
    return;
  }
  if (config === null) {
    // No role is known yet, so report against the request without one.
    post({
      type: "error",
      role: "staffSymbol",
      requestId: request.requestId,
      message: "Received a process request before the worker was configured",
    });
    return;
  }
  const settings = config;
  process(settings, request.requestId, request.image).catch((error) => {
    post({
      type: "error",
      role: settings.role,
      requestId: request.requestId,
      message: messageOf(error),
    });
  });
});
