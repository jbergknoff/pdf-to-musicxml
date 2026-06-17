import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../../lib/types";
import type {
  OmrConfig,
  ProgressUpdate,
  WorkerInbound,
  WorkerOutbound,
  WorkerRole,
} from "./protocol";

/**
 * Main-thread handle to the OMR pipeline. {@link createOmrClient} spins up one
 * worker per segmentation model and resolves once both report their inference
 * provider. The two models are independent, so they run concurrently (separate
 * ORT instances / WebGPU devices) and their masks are merged here; this overlaps
 * each model's GPU work with the other's CPU-side tiling/readback. The pipeline
 * runs off the main thread, so a long segmentation never freezes the UI.
 */

export interface OmrResult {
  masks: SegmentationMasks;
  staves: StaffStructure;
}

export interface OmrClient {
  /** Inference provider the workers resolved (e.g. "webgpu" | "wasm"). */
  readonly provider: string;
  /** Run the pipeline on one decoded page, streaming progress. */
  process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult>;
  /** Terminate the workers (used when the config changes and we recreate them). */
  dispose(): void;
}

const ROLES: readonly WorkerRole[] = ["staffSymbol", "symbolDetail"];

/** Partial results collected from each worker until both halves have arrived. */
interface JobState {
  resolve(result: OmrResult): void;
  reject(error: Error): void;
  onProgress(update: ProgressUpdate): void;
  staffSymbol?: Extract<
    WorkerOutbound,
    { type: "result"; role: "staffSymbol" }
  >;
  symbolDetail?: Extract<
    WorkerOutbound,
    { type: "result"; role: "symbolDetail" }
  >;
  // Last segmenting fraction reported per role, averaged into overall progress.
  progress: Map<WorkerRole, number>;
}

export function createOmrClient(config: OmrConfig): Promise<OmrClient> {
  // Two workers share the CPU, so halve the WASM thread pool each to avoid
  // oversubscribing it (no effect on the WebGPU path). Build as its own entry
  // point to dist/omr.worker.js (see scripts/build.ts).
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 2;
  const wasmThreads = Math.max(1, Math.floor(cores / 2));

  const workers = new Map<WorkerRole, Worker>();
  for (const role of ROLES) {
    const worker = new Worker("/omr.worker.js", { type: "module" });
    worker.postMessage({
      type: "config",
      ...config,
      role,
      wasmThreads,
    } satisfies WorkerInbound);
    workers.set(role, worker);
  }

  const jobs = new Map<number, JobState>();
  let nextRequestId = 0;

  function dispose() {
    for (const worker of workers.values()) {
      worker.terminate();
    }
    for (const job of jobs.values()) {
      job.reject(new Error("Inference workers were disposed"));
    }
    jobs.clear();
  }

  function failJob(requestId: number, message: string) {
    const job = jobs.get(requestId);
    if (job === undefined) {
      return;
    }
    jobs.delete(requestId);
    job.reject(new Error(message));
  }

  function tryComplete(requestId: number, job: JobState) {
    if (job.staffSymbol === undefined || job.symbolDetail === undefined) {
      return;
    }
    jobs.delete(requestId);
    const staffSymbol = job.staffSymbol;
    const symbolDetail = job.symbolDetail;
    const masks: SegmentationMasks = {
      width: staffSymbol.width,
      height: staffSymbol.height,
      staff: staffSymbol.staff,
      symbols: staffSymbol.symbols,
      stemsRests: symbolDetail.stemsRests,
      noteheads: symbolDetail.noteheads,
      clefsKeys: symbolDetail.clefsKeys,
    };
    job.resolve({ masks, staves: staffSymbol.staves });
  }

  function handleMessage(message: WorkerOutbound) {
    if (message.type === "ready") {
      return;
    }
    const job = jobs.get(message.requestId);
    if (job === undefined) {
      return;
    }
    switch (message.type) {
      case "progress": {
        // Average the two models' segmenting fractions into one bar; forward
        // other phases (loading-models, detecting-staves) as they come.
        if (message.phase === "segmenting") {
          job.progress.set(message.role, message.fraction);
          let total = 0;
          for (const role of ROLES) {
            total += job.progress.get(role) ?? 0;
          }
          job.onProgress({
            phase: "segmenting",
            fraction: total / ROLES.length,
          });
        } else {
          job.onProgress({
            phase: message.phase,
            fraction: message.fraction,
            detail: message.detail,
          });
        }
        break;
      }
      case "result": {
        if (message.role === "staffSymbol") {
          job.staffSymbol = message;
        } else {
          job.symbolDetail = message;
        }
        tryComplete(message.requestId, job);
        break;
      }
      case "error": {
        failJob(message.requestId, message.message);
        break;
      }
    }
  }

  function process(
    image: RgbaImage,
    onProgress: (update: ProgressUpdate) => void,
  ): Promise<OmrResult> {
    const requestId = nextRequestId++;
    return new Promise<OmrResult>((resolve, reject) => {
      jobs.set(requestId, {
        resolve,
        reject,
        onProgress,
        progress: new Map(),
      });
      // Each worker gets its own structured clone of the page (no transfer, so
      // both keep a copy); they segment their model in parallel.
      for (const worker of workers.values()) {
        const request: WorkerInbound = { type: "process", requestId, image };
        worker.postMessage(request);
      }
    });
  }

  // Resolve the client once both workers report their provider.
  return new Promise<OmrClient>((resolveClient) => {
    const readyProviders = new Map<WorkerRole, string>();
    for (const [role, worker] of workers) {
      worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
        const message = event.data;
        if (message.type === "ready") {
          readyProviders.set(role, message.provider);
          if (readyProviders.size === workers.size) {
            resolveClient({
              provider: readyProviders.get("staffSymbol") ?? message.provider,
              process,
              dispose,
            });
          }
          return;
        }
        handleMessage(message);
      };
    }
  });
}
