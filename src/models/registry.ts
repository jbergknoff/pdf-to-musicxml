import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  MODEL_MANIFEST,
  type ModelManifestEntry,
  modelUrl,
} from "../../lib/models/manifest";
import {
  type SegmentationModels,
  STAFF_SYMBOL_MODEL_SPEC,
  SYMBOL_DETAIL_MODEL_SPEC,
} from "../../lib/segmentation/segment";
import type { SegmentationModel } from "../../lib/segmentation/unet-session";

/**
 * Loads the ONNX model weights, caching the downloaded bytes so repeat visits
 * (and offline use) skip the network.
 *
 * The weights are large (~70 MB + ~38 MB) and live in Netlify Blobs rather than
 * the static deploy; a function streams them back from the same origin at
 * `/models/<file>` (see netlify/functions/models.mts). Same-origin matters under
 * cross-origin isolation (COEP `require-corp`). The versioned, immutable URLs
 * come from the shared manifest; once fetched the bytes are stored in the Cache
 * Storage API. Locally, `scripts/serve.ts` serves the same paths from disk.
 */

const CACHE_NAME = "pdf-to-musicxml-models-v1";

/** Fetch a model's bytes, serving from Cache Storage when available. */
async function fetchModelBytes(entry: ModelManifestEntry): Promise<Uint8Array> {
  const url = modelUrl(entry);
  const cache =
    typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : undefined;
  let response = await cache?.match(url);
  if (response === undefined) {
    response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch model "${entry.fileName}" from ${url}: ${response.status}`,
      );
    }
    await cache?.put(url, response.clone());
  }
  return new Uint8Array(await response.arrayBuffer());
}

export interface LoadModelsOptions {
  /** Reports which model is being loaded, for UI status. */
  onAssetLoading?: (entry: ModelManifestEntry) => void;
}

/** Download (or read from cache) the `unet_big` model and build its session. */
export async function loadStaffSymbolModel(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<SegmentationModel> {
  options.onAssetLoading?.(MODEL_MANIFEST.staffSymbol);
  const bytes = await fetchModelBytes(MODEL_MANIFEST.staffSymbol);
  const session = await backend.createSession(bytes);
  return { spec: STAFF_SYMBOL_MODEL_SPEC, session };
}

/** Download (or read from cache) the `seg_net` model and build its session. */
export async function loadSymbolDetailModel(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<SegmentationModel> {
  options.onAssetLoading?.(MODEL_MANIFEST.symbolDetail);
  const bytes = await fetchModelBytes(MODEL_MANIFEST.symbolDetail);
  const session = await backend.createSession(bytes);
  return { spec: SYMBOL_DETAIL_MODEL_SPEC, session };
}

/**
 * Download (or read from cache) both segmentation models and create their
 * inference sessions on the given backend. The parallel worker pipeline loads
 * the two models separately (one per worker); this stays for any single-worker
 * or test path that wants both at once.
 */
export async function loadSegmentationModels(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<SegmentationModels> {
  const staffSymbol = await loadStaffSymbolModel(backend, options);
  const symbolDetail = await loadSymbolDetailModel(backend, options);
  return { staffSymbol, symbolDetail };
}
