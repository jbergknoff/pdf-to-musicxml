import * as ort from "onnxruntime-node";
import type {
  InferenceBackend,
  Tensor,
  TensorDataType,
} from "../lib/runtime/inference-backend";

/**
 * Headless inference backend for out-of-band Bun/Node scripts (e.g.
 * `compare-resolutions.ts`). Mirrors `src/runtime/web-backend.ts` but runs the
 * real models on onnxruntime-node's CPU EP — no browser, no WebGPU. Speed is not
 * the point here; matching the browser's numerics on the same `lib/` pipeline is.
 */

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

export async function createNodeBackend(): Promise<InferenceBackend> {
  return {
    provider: "cpu",
    async createSession(modelBytes) {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["cpu"],
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
