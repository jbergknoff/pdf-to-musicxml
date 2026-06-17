import * as ort from "onnxruntime-web";
import type {
  InferenceBackend,
  Tensor,
  TensorDataType,
} from "../../lib/runtime/inference-backend";
import { recordWebGpuKernel } from "./webgpu-profile";

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
 * honored even if the adapter probe is unsure, on purpose. `profiling` turns on
 * ORT's verbose logging + WebGPU per-kernel timings to find the slow ops.
 */
export type ForcedProvider = "webgpu" | "wasm";

export interface WebBackendOptions {
  forcedProvider?: ForcedProvider;
  profiling?: boolean;
}

export async function createWebBackend(
  options: WebBackendOptions = {},
): Promise<InferenceBackend> {
  const { forcedProvider, profiling = false } = options;
  let provider: ForcedProvider;
  if (forcedProvider !== undefined) {
    provider = forcedProvider;
  } else {
    provider = (await hasWebGpuAdapter()) ? "webgpu" : "wasm";
  }

  // Off: quiet the per-load "some nodes were not assigned to the preferred EP"
  // notice (benign — shape ops run on CPU) so it doesn't bury our [omr] logs.
  // On: go verbose, which prints the full node->EP assignment dump, and route
  // WebGPU's per-kernel timings into our aggregator (see webgpu-profile.ts)
  // instead of ORT's default per-kernel console spam. Together they show which
  // ops fell back to CPU and where the GPU time actually goes. `ondata` isn't in
  // ORT's published profiling type yet, hence the structural cast.
  if (profiling) {
    ort.env.logLevel = "verbose";
    (
      ort.env.webgpu as {
        profiling?: {
          mode: "default" | "off";
          ondata?: (data: unknown) => void;
        };
      }
    ).profiling = {
      mode: "default",
      ondata: (data) => {
        recordWebGpuKernel(data as Parameters<typeof recordWebGpuKernel>[0]);
      },
    };
  } else {
    ort.env.logLevel = "error";
  }
  // The native runtime logs the EP-assignment notice at warning level; 3=error
  // suppresses it, 0=verbose surfaces the assignments when profiling.
  const sessionLogSeverityLevel = profiling ? 0 : 3;

  console.info(
    `[omr] inference provider: ${provider}${forcedProvider !== undefined ? " (forced)" : ""}, wasm threads: ${ort.env.wasm.numThreads}${profiling ? ", profiling" : ""}`,
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
        logSeverityLevel: sessionLogSeverityLevel,
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
