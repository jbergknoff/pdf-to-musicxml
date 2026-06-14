import * as ort from "onnxruntime-web";
import type {
  InferenceBackend,
  Tensor,
} from "../../lib/runtime/inference-backend";

// ORT Web fetches its WASM assets at runtime; serve them from /ort/ (see
// scripts/build.ts, which copies them there, and scripts/serve.ts).
ort.env.wasm.wasmPaths = "/ort/";

/**
 * Browser inference backend. Prefers WebGPU when available, falling back to the
 * threaded WASM backend. The page must be cross-origin isolated for the WASM
 * threads to work (see scripts/serve.ts / netlify.toml).
 */
export async function createWebBackend(): Promise<InferenceBackend> {
  const provider = "gpu" in navigator ? "webgpu" : "wasm";
  return {
    provider,
    async createSession(modelBytes) {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [provider, "wasm"],
      });
      return {
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            ortFeeds[name] = new ort.Tensor(
              "float32",
              tensor.data,
              tensor.dims,
            );
          }
          const results = await session.run(ortFeeds);
          const output: Record<string, Tensor> = {};
          for (const [name, value] of Object.entries(results)) {
            output[name] = {
              data: value.data as Float32Array,
              dims: value.dims as number[],
            };
          }
          return output;
        },
      };
    },
  };
}
