/**
 * Single source of truth for the model weights: where they come from, the
 * versioned file name they are served under, and the URL/blob-key mapping.
 * This module is plain data (no DOM, ORT, or Netlify imports) so it can be
 * shared by the browser registry (`src/models`), the out-of-band upload
 * script (`scripts/upload-models.ts`), and the Netlify serving function
 * (`netlify/functions`).
 *
 * The weights are served from Netlify Blobs (not bundled into the static
 * deploy): they are uploaded once with the Netlify CLI and a function streams
 * them back at `/models/<file>`. The file names are **versioned**
 * (`MODEL_VERSION`) so each URL is immutable — clients can cache it forever,
 * and bumping the version is how new weights are rolled out.
 */

/**
 * Bump when the underlying weights change to invalidate caches. The served
 * oemer weights are run through `scripts/optimize-models.py` (onnxsim with a
 * fixed input shape); a bump also rolls out a re-optimization. The TrOMR
 * weights are served as-is from the homr onnx_checkpoints release.
 */
export const MODEL_VERSION = "v2";

/**
 * Name of the Netlify Blobs store the weights live in. They are uploaded once,
 * out of band, with the Netlify CLI (`scripts/upload-models.ts`) rather than
 * at deploy time — the ~109 MB upload is too slow for the build. The serving
 * function reads this same site-wide store.
 */
export const MODEL_STORE_NAME = "models";

/** Same-origin path prefix the weights are requested under. */
export const MODEL_URL_PREFIX = "/models/";

export type ModelId =
  | "staffSymbol"
  | "symbolDetail"
  | "tromrEncoder"
  | "tromrDecoder";

export interface ModelManifestEntry {
  /** Stable identifier used in code. */
  id: ModelId;
  /** Where the build downloads the original weights from. */
  sourceUrl: string;
  /**
   * If true, `sourceUrl` points to a ZIP archive. `scripts/download-models.ts`
   * extracts the single ONNX file inside and saves it under `fileName`.
   */
  sourceIsZip?: boolean;
  /**
   * Versioned file name. Doubles as the Netlify Blobs key, the local cache
   * file name, and the last segment of the served URL, so the three stay in
   * lockstep.
   */
  fileName: string;
  /**
   * The fixed input shape the served (optimized) weights are baked to.
   *
   * For the oemer segmentation models this is channel-last `[N, H, W, C]`
   * (uint8 NHWC). For TrOMR encoder it is channel-first `[N, C, H, W]`
   * (float32 NCHW) with `C = 1` (grayscale) and `H` fixed while `W` is
   * variable — stored as 0 to indicate "variable". For the TrOMR decoder the
   * shape is not a simple 4-D image tensor; the field is set to all-zeros.
   */
  inputShape: readonly [number, number, number, number];
}

const OEMER_RELEASE_BASE =
  "https://github.com/BreezeWhite/oemer/releases/download/checkpoints";

/**
 * The TrOMR encoder and decoder are the Polyphonic-TrOMR weights (NetEase,
 * Apache-2.0) pre-exported to ONNX by the homr project (liebharc, AGPL-3.0).
 * The ONNX binaries are data (not AGPL code) and carry the original Apache-2.0
 * provenance. They are downloaded as ZIP archives from the homr onnx_checkpoints
 * release and extracted by scripts/download-models.ts.
 */
const TROMR_RELEASE_BASE =
  "https://github.com/liebharc/homr/releases/download/onnx_checkpoints";
const TROMR_CHECKPOINT = "396-f6feedb42ff90087d898b0941a55d040fa6b2903";

export const MODEL_MANIFEST: Record<ModelId, ModelManifestEntry> = {
  staffSymbol: {
    id: "staffSymbol",
    sourceUrl: `${OEMER_RELEASE_BASE}/1st_model.onnx`,
    fileName: `oemer-unet_big-staffline-symbol-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 256, 256, 3],
  },
  symbolDetail: {
    id: "symbolDetail",
    sourceUrl: `${OEMER_RELEASE_BASE}/2nd_model.onnx`,
    fileName: `oemer-seg_net-symbol-class-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 288, 288, 3],
  },
  tromrEncoder: {
    id: "tromrEncoder",
    sourceUrl: `${TROMR_RELEASE_BASE}/encoder_pytorch_model_${TROMR_CHECKPOINT}.zip`,
    sourceIsZip: true,
    fileName: `tromr-encoder.${MODEL_VERSION}.onnx`,
    // [N, C, H, W] — batch 1, 1 grayscale channel, fixed 256 × 1280.
    inputShape: [1, 1, 256, 1280],
  },
  tromrDecoder: {
    id: "tromrDecoder",
    sourceUrl: `${TROMR_RELEASE_BASE}/decoder_pytorch_model_${TROMR_CHECKPOINT}.zip`,
    sourceIsZip: true,
    fileName: `tromr-decoder.${MODEL_VERSION}.onnx`,
    // The decoder has no simple 4-D image input; shape is not applicable.
    inputShape: [0, 0, 0, 0],
  },
};

export const MODEL_ENTRIES: ModelManifestEntry[] =
  Object.values(MODEL_MANIFEST);

/**
 * TrOMR inference constants. The encoder takes a grayscale staff strip
 * ([1, 1, H, W] float32) and emits context features ([1, seq_len, 512]).
 * The decoder is an autoregressive transformer with KV cache:
 *   - decoder_depth=8 layers × 4 KV tensors = 32 cache tensors
 *   - heads=8, head_dim=512/8=64, so each cache tensor is [1, 8, seq, 64]
 */
export const TROMR_CONSTANTS = {
  /** Fixed input height (pixels) the TrOMR encoder ONNX was exported at. */
  inputHeight: 256,
  /** Fixed input width (pixels) the TrOMR encoder ONNX was exported at. */
  inputWidth: 1280,
  /** Number of KV-cache tensors (decoder_depth × 4). */
  numCacheTensors: 32,
  /** Number of attention heads in the decoder. */
  numHeads: 8,
  /** Head dimension = decoder_dim / num_heads = 512 / 8. */
  headDim: 64,
  /** Maximum autoregressive decoding steps per staff. */
  maxDecodingSteps: 256,
} as const;

/** The same-origin URL a model is fetched from in the browser. */
export function modelUrl(entry: ModelManifestEntry): string {
  return `${MODEL_URL_PREFIX}${entry.fileName}`;
}

/**
 * The Netlify Blobs key for a served URL path, or `null` if the path is not a
 * model request. Used by the serving function to translate `/models/<file>`
 * into the deploy-store key (which is just `<file>`).
 */
export function blobKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith(MODEL_URL_PREFIX)) {
    return null;
  }
  const key = pathname.slice(MODEL_URL_PREFIX.length);
  // Reject empty keys and any path traversal — keys are flat file names.
  if (key.length === 0 || key.includes("/") || key.includes("..")) {
    return null;
  }
  return key;
}
