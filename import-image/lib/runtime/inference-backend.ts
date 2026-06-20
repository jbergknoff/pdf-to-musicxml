/**
 * Runtime-agnostic inference interface.
 *
 * `lib/` runs in both Node/Bun (with onnxruntime-node, for unit tests) and the
 * browser (with onnxruntime-web). To keep `lib/` free of any concrete ORT
 * dependency, the runtime is injected through this interface; implementations
 * live in `src/runtime/` (web) and in tests (node).
 */

/**
 * The element types a {@link Tensor} can hold. The oemer segmentation models
 * take `uint8` RGB patches and emit `float32` probabilities; TrOMR uses
 * `int64` for token IDs and cache length counters.
 */
export type TensorDataType = "float32" | "uint8" | "int64";

export interface Tensor {
  type: TensorDataType;
  data: Float32Array | Uint8Array | BigInt64Array;
  dims: number[];
}

export interface InferenceSession {
  /** The ordered input tensor names as declared in the ONNX graph. */
  readonly inputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}

export interface CreateSessionOptions {
  /**
   * Force this session onto the WASM execution provider even when the backend
   * otherwise uses WebGPU. The TrOMR decoder needs this: its fused
   * `SkipLayerNormalization` op does not run on ORT's WebGPU EP, and its 256
   * tiny autoregressive steps are dominated by per-dispatch latency there, so
   * WASM is both the only working and the faster path for it. Segmentation and
   * the encoder (large single forward passes) still run on WebGPU.
   */
  forceWasm?: boolean;
}

export interface InferenceBackend {
  /** Execution provider actually selected, e.g. "webgpu" | "wasm" | "cpu". */
  readonly provider: string;
  createSession(
    modelBytes: Uint8Array,
    options?: CreateSessionOptions,
  ): Promise<InferenceSession>;
}
