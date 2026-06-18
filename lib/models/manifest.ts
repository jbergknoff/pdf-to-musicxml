/**
 * Single source of truth for the segmentation model weights: where they come
 * from, the versioned file name they are served under, and the URL/blob-key
 * mapping. This module is plain data (no DOM, ORT, or Netlify imports) so it can
 * be shared by the browser registry (`src/models`), the out-of-band upload
 * script (`scripts/upload-models.ts`), and the Netlify serving function
 * (`netlify/functions`).
 *
 * The weights are served from Netlify Blobs (not bundled into the static
 * deploy): they are uploaded once with the Netlify CLI and a function streams
 * them back at `/models/<file>`. The file names are **versioned**
 * (`MODEL_VERSION`) so each URL is immutable — clients can cache it forever, and
 * bumping the version is how new weights are rolled out.
 */

/**
 * Bump when the underlying weights change to invalidate caches. The served
 * weights are the oemer originals run through `scripts/optimize-models.py`
 * (onnxsim with a fixed input shape — see `docs/model-optimization-plan.md`), so
 * a bump also rolls out a re-optimization. Re-run `make optimize-models` and
 * `make upload-models` after bumping.
 */
export const MODEL_VERSION = "v2";

/**
 * Name of the Netlify Blobs store the weights live in. They are uploaded once,
 * out of band, with the Netlify CLI (`scripts/upload-models.ts`) rather than at
 * deploy time — the ~109 MB upload is too slow for the build. The serving
 * function reads this same site-wide store.
 */
export const MODEL_STORE_NAME = "models";

/** Same-origin path prefix the weights are requested under. */
export const MODEL_URL_PREFIX = "/models/";

export type ModelId = "staffSymbol" | "symbolDetail";

export interface ModelManifestEntry {
  /** Stable identifier used in code. */
  id: ModelId;
  /** Where the build downloads the original weights from (oemer, MIT). */
  sourceUrl: string;
  /**
   * Versioned file name. Doubles as the Netlify Blobs key, the local cache file
   * name, and the last segment of the served URL, so the three stay in lockstep.
   */
  fileName: string;
  /**
   * The fixed input shape the served (optimized) weights are baked to, channel-
   * last `[N, H, W, C]`. `scripts/optimize-models.py` freezes this shape so
   * onnxsim can fold the model's dynamic-shape machinery away (the prime suspect
   * for the slow WebGPU path), and the pipeline must feed exactly `N` tiles per
   * inference. `N = 1` keeps every dispatch small (immune to both backends' big-
   * batch failures) and shapes fully static. See `docs/model-optimization-plan.md`.
   */
  inputShape: readonly [number, number, number, number];
}

const RELEASE_BASE =
  "https://github.com/BreezeWhite/oemer/releases/download/checkpoints";

export const MODEL_MANIFEST: Record<ModelId, ModelManifestEntry> = {
  staffSymbol: {
    id: "staffSymbol",
    sourceUrl: `${RELEASE_BASE}/1st_model.onnx`,
    // <source>-<arch>-<role>.<version>.onnx
    fileName: `oemer-unet_big-staffline-symbol-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 256, 256, 3],
  },
  symbolDetail: {
    id: "symbolDetail",
    sourceUrl: `${RELEASE_BASE}/2nd_model.onnx`,
    fileName: `oemer-seg_net-symbol-class-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 288, 288, 3],
  },
};

export const MODEL_ENTRIES: ModelManifestEntry[] =
  Object.values(MODEL_MANIFEST);

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
