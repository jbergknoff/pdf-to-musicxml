import type {
  InferenceBackend,
  InferenceSession,
} from "../../lib/runtime/inference-backend";
import {
  MODEL_MANIFEST,
  type ModelManifestEntry,
  modelUrl,
} from "../../lib/models/manifest";
import type { TrOMRSessions } from "../../lib/transcription/tromr-session";
import {
  createSegmentationModels,
  type SegmentationModels,
} from "../../lib/segmentation/segment";

/**
 * Loads the ONNX model weights, caching the downloaded bytes so repeat visits
 * (and offline use) skip the network.
 *
 * The weights are large (~70 MB + ~38 MB) and live in Netlify Blobs rather
 * than the static deploy; a function streams them back from the same origin at
 * `/models/<file>` (see netlify/functions/models.mts). Same-origin matters
 * under cross-origin isolation (COEP `require-corp`). The versioned, immutable
 * URLs come from the shared manifest; once fetched the bytes are stored in the
 * Cache Storage API. Locally, `scripts/serve.ts` serves the same paths from
 * disk.
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

/**
 * Download (or read from cache) both segmentation models and create their
 * inference sessions on the given backend.
 */
export async function loadSegmentationModels(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<SegmentationModels> {
  options.onAssetLoading?.(MODEL_MANIFEST.staffSymbol);
  const staffSymbolBytes = await fetchModelBytes(MODEL_MANIFEST.staffSymbol);
  const staffSymbolSession = await backend.createSession(staffSymbolBytes);

  options.onAssetLoading?.(MODEL_MANIFEST.symbolDetail);
  const symbolDetailBytes = await fetchModelBytes(MODEL_MANIFEST.symbolDetail);
  const symbolDetailSession = await backend.createSession(symbolDetailBytes);

  return createSegmentationModels(staffSymbolSession, symbolDetailSession);
}

/**
 * Download (or read from cache) the TrOMR encoder and decoder models and
 * create their inference sessions on the given backend. Returns both sessions
 * as a `TrOMRSessions` object for the transcription pipeline.
 */
export async function loadTrOMRModels(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<TrOMRSessions> {
  options.onAssetLoading?.(MODEL_MANIFEST.tromrEncoder);
  const encoderBytes = await fetchModelBytes(MODEL_MANIFEST.tromrEncoder);
  const encoder: InferenceSession = await backend.createSession(encoderBytes);

  // Pin the decoder to WASM (see CreateSessionOptions.forceWasm): its fused
  // SkipLayerNormalization op fails on ORT's WebGPU EP, and its many tiny
  // autoregressive steps run faster on WASM regardless. The encoder above stays
  // on whatever the backend selected (WebGPU when available).
  options.onAssetLoading?.(MODEL_MANIFEST.tromrDecoder);
  const decoderBytes = await fetchModelBytes(MODEL_MANIFEST.tromrDecoder);
  const decoder: InferenceSession = await backend.createSession(decoderBytes, {
    forceWasm: true,
  });

  return { encoder, decoder };
}
