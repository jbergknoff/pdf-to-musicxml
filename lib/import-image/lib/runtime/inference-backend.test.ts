import { describe, expect, it } from "bun:test";
import type { InferenceBackend, Tensor } from "./inference-backend";

// Phase 0 locks the injected-runtime pattern: code that runs inference depends
// only on InferenceBackend / InferenceSession / Tensor, never on a concrete ORT
// package. Both the browser backend (onnxruntime-web) and the node backend used
// by future unit tests (onnxruntime-node) must satisfy this contract. We verify
// the contract here against an in-memory fake so the interface stays usable
// without importing either ORT package.

function createDoublingBackend(): InferenceBackend {
  return {
    provider: "fake",
    async createSession() {
      return {
        inputNames: ["input"],
        async run(feeds) {
          const output: Record<string, Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            // Fake backend: only doubles float32 tensors (sufficient for this test).
            const doubled = new Float32Array(
              (tensor.data as Float32Array).map((v) => v * 2),
            );
            output[name] = {
              type: tensor.type,
              data: doubled,
              dims: tensor.dims,
            };
          }
          return output;
        },
      };
    },
  };
}

describe("InferenceBackend contract", () => {
  it("exposes the selected provider", () => {
    const backend = createDoublingBackend();
    expect(backend.provider).toBe("fake");
  });

  it("runs a session over named float tensors", async () => {
    const backend = createDoublingBackend();
    const session = await backend.createSession(new Uint8Array());
    const result = await session.run({
      input: {
        type: "float32",
        data: new Float32Array([1, 2, 3]),
        dims: [1, 3],
      },
    });
    expect(Array.from(result.input.data as Float32Array)).toEqual([2, 4, 6]);
    expect(result.input.dims).toEqual([1, 3]);
    expect(result.input.type).toBe("float32");
  });
});
