import * as ort from "onnxruntime-web";
import type {
  InferenceBackend,
  Tensor,
  TensorDataType,
} from "../../lib/runtime/inference-backend";

// ORT Web fetches its WASM assets at runtime; serve them from /ort/ (see
// scripts/build.ts, which copies them there, and scripts/serve.ts).
ort.env.wasm.wasmPaths = "/ort/";

// Use every available core for the threaded WASM backend. ORT's default can be
// conservative (especially inside a worker), and segmentation is dominated by
// many small inferences, so more threads is a near-linear win on the CPU path.
// The page must be cross-origin isolated for WASM threads to spin up at all.
if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) {
  ort.env.wasm.numThreads = navigator.hardwareConcurrency;
}

function toOrtTensor(tensor: Tensor): ort.Tensor {
  if (tensor.type === "uint8") {
    return new ort.Tensor("uint8", tensor.data as Uint8Array, tensor.dims);
  }
  return new ort.Tensor("float32", tensor.data as Float32Array, tensor.dims);
}

function fromOrtTensor(value: ort.Tensor): Tensor {
  return {
    type: value.type as TensorDataType,
    data: value.data as Float32Array | Uint8Array,
    dims: value.dims as number[],
  };
}

/**
 * Probe for a genuinely usable WebGPU adapter. `"gpu" in navigator` only means
 * the API exists; on many machines/browsers `requestAdapter()` still returns
 * null (or throws), and requesting the WebGPU execution provider in that state
 * makes ORT log a "Failed to get GPU adapter" error and, worse, can hang a
 * second session. So we only use WebGPU when an adapter actually resolves.
 */
interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = (navigator as { gpu?: GpuLike }).gpu;
  if (gpu === undefined) {
    return false;
  }
  try {
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

/**
 * Browser inference backend. Uses WebGPU when a working adapter is available,
 * otherwise the threaded WASM backend. The page must be cross-origin isolated
 * for the WASM threads to work (see scripts/serve.ts / netlify.toml).
 *
 * `forcedProvider` overrides the auto-detection (wired to the UI backend
 * picker) so the two paths can be timed against each other; forcing WebGPU is
 * honored even if the adapter probe is unsure, on purpose.
 */
export type ForcedProvider = "webgpu" | "wasm";

export interface WebBackendOptions {
  forcedProvider?: ForcedProvider;
  /**
   * Override the WASM thread count (default: all cores). Used to split the CPU
   * across the two model workers so they don't oversubscribe it.
   */
  wasmThreads?: number;
}

export async function createWebBackend(
  options: WebBackendOptions = {},
): Promise<InferenceBackend> {
  const { forcedProvider, wasmThreads } = options;
  if (wasmThreads !== undefined && wasmThreads > 0) {
    ort.env.wasm.numThreads = wasmThreads;
  }
  let provider: ForcedProvider;
  if (forcedProvider !== undefined) {
    provider = forcedProvider;
  } else {
    provider = (await hasWebGpuAdapter()) ? "webgpu" : "wasm";
  }

  // Keep ORT at error level. Lower levels flood the console: verbose logs one
  // line per kernel on every Run (100k+ entries over a full page, enough to
  // crash the console/renderer), and even the warning level repeats the benign
  // "some nodes were not assigned to the preferred EP" notice on every load and
  // buries our [omr] logs. The per-session floor (logSeverityLevel: 3 below)
  // matches it, since the native runtime emits that notice at warning level.
  ort.env.logLevel = "error";

  console.info(
    `[omr] inference provider: ${provider}${forcedProvider !== undefined ? " (forced)" : ""}, wasm threads: ${ort.env.wasm.numThreads}`,
  );
  // Only list WebGPU when we confirmed it works; otherwise ORT would try (and
  // noisily fail) the WebGPU EP before falling back.
  const executionProviders =
    provider === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  return {
    provider,
    async createSession(modelBytes) {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders,
        logSeverityLevel: 3,
      });
      return {
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            ortFeeds[name] = toOrtTensor(tensor);
          }
          const results = await session.run(ortFeeds);
          const output: Record<string, Tensor> = {};
          for (const [name, value] of Object.entries(results)) {
            output[name] = fromOrtTensor(value);
          }
          return output;
        },
      };
    },
  };
}
