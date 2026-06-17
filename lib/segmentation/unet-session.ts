import type { InferenceSession, Tensor } from "../runtime/inference-backend";
import type {
  ProbabilityMap,
  RgbaImage,
  SegmentationModelSpec,
} from "../types";
import {
  addTilePrediction,
  createProbabilityAccumulator,
  cropPatch,
  finalizeProbabilityMap,
  isTileBlank,
  planTiles,
  type Tile,
} from "./tiling";

/**
 * Drives one oemer segmentation model over a full page with the sliding-window
 * tiling in `tiling.ts`. A {@link SegmentationModelSpec} carries the geometry
 * (window size, stride, class count) and tensor names; the {@link
 * InferenceSession} comes from the injected backend so this stays runtime-
 * agnostic.
 */

/** A model's inference session paired with the spec describing how to feed it. */
export interface SegmentationModel {
  spec: SegmentationModelSpec;
  session: InferenceSession;
}

export interface RunSegmentationOptions {
  /** Tiles inferred per `session.run` call. Trades memory for fewer calls. */
  batchSize?: number;
  /** Reports tiling progress as a fraction in [0, 1] after each batch. */
  onProgress?: (fraction: number) => void;
  /** Label for the perf log line, so the two models can be told apart. */
  label?: string;
}

// Segmentation is overhead-bound (many small tiles), so larger batches amortize
// per-call cost. This library default is deliberately middling; callers pick a
// provider-specific size, because both backends have hard upper bounds — ORT-
// wasm overflows 32-bit byte-size math and WebGPU crashes the GPU process on an
// oversized dispatch (see the worker's WASM_BATCH_SIZE / WEBGPU_BATCH_SIZE).
const DEFAULT_BATCH_SIZE = 16;

// A tile whose every pixel is lighter than this (Rec. 601 luma, 0–255) holds no
// printed notation, so it is skipped. Set conservatively low: dark/faint marks
// keep the tile, only genuine page background is dropped.
const INK_LUMINANCE = 160;

/**
 * Run `model` over `image`, returning the averaged per-pixel class
 * probabilities at the image's resolution. Tiles are inferred in batches and
 * their softmax outputs averaged where they overlap.
 */
export async function runSegmentationModel(
  image: RgbaImage,
  model: SegmentationModel,
  options: RunSegmentationOptions = {},
): Promise<ProbabilityMap> {
  const { spec, session } = model;
  const { windowSize, stepSize, channels, inputName, outputName } = spec;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const allTiles = planTiles(image.width, image.height, windowSize, stepSize);
  // Skip pure-background tiles (margins, inter-system gaps): they only ever
  // produce the background class, so inferring them is wasted work. Uncovered
  // pixels finalize to background anyway.
  const tiles = allTiles.filter(
    (tile) => !isTileBlank(image, tile, windowSize, INK_LUMINANCE),
  );
  const accumulator = createProbabilityAccumulator(
    image.width,
    image.height,
    channels,
  );
  const patchVolume = windowSize * windowSize;

  // Logged up front (not just on completion) so a mid-run crash still leaves a
  // breadcrumb showing which model and how many tiles were in flight.
  const label = options.label ?? "model";
  const skipped = allTiles.length - tiles.length;
  console.info(
    `[omr] ${label}: ${tiles.length} tiles (window ${windowSize}, step ${stepSize}, batch ${batchSize}, ${skipped} blank skipped)`,
  );
  const modelStart = performance.now();

  for (let start = 0; start < tiles.length; start += batchSize) {
    const batch = tiles.slice(start, start + batchSize);
    const input = packBatch(image, batch, windowSize);
    const results = await session.run({ [inputName]: input });
    const output = results[outputName];
    if (output === undefined) {
      throw new Error(`Model produced no output named "${outputName}"`);
    }
    const predictions = output.data as Float32Array;

    batch.forEach((tile, indexInBatch) => {
      const offset = indexInBatch * patchVolume * channels;
      const patch = predictions.subarray(
        offset,
        offset + patchVolume * channels,
      );
      addTilePrediction(accumulator, tile, patch, windowSize);
    });

    options.onProgress?.(
      Math.min(start + batch.length, tiles.length) / tiles.length,
    );
  }

  const elapsedMs = performance.now() - modelStart;
  const perTile =
    tiles.length > 0 ? (elapsedMs / tiles.length).toFixed(1) : "0";
  console.info(
    `[omr] ${label}: ${Math.round(elapsedMs)}ms (${perTile}ms/tile)`,
  );

  return finalizeProbabilityMap(accumulator);
}

/** Stack a batch of RGB patches into one channel-last `uint8` input tensor. */
function packBatch(
  image: RgbaImage,
  batch: Tile[],
  windowSize: number,
): Tensor {
  const patchLength = windowSize * windowSize * 3;
  const data = new Uint8Array(batch.length * patchLength);
  batch.forEach((tile, index) => {
    data.set(cropPatch(image, tile, windowSize), index * patchLength);
  });
  return {
    type: "uint8",
    data,
    dims: [batch.length, windowSize, windowSize, 3],
  };
}
