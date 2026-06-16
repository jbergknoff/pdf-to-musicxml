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
}

// Segmentation is overhead-bound (many small tiles), so larger batches amortize
// per-call cost — critical on WebGPU, where each `session.run` pays CPU<->GPU
// dispatch and sync. 16 was a good balance of throughput vs. memory in practice.
const DEFAULT_BATCH_SIZE = 16;

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

  const tiles = planTiles(image.width, image.height, windowSize, stepSize);
  const accumulator = createProbabilityAccumulator(
    image.width,
    image.height,
    channels,
  );
  const patchVolume = windowSize * windowSize;

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
