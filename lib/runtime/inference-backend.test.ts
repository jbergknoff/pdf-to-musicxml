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
        async run(feeds) {
          const output: Record<string, Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            output[name] = {
              data: tensor.data.map((value) => value * 2),
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
      input: { data: new Float32Array([1, 2, 3]), dims: [1, 3] },
    });
    expect(Array.from(result.input.data)).toEqual([2, 4, 6]);
    expect(result.input.dims).toEqual([1, 3]);
  });
});
