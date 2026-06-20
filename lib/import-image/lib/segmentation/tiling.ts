import type { ProbabilityMap, RgbaImage } from "../types";

/**
 * Tiled-inference geometry shared by both segmentation models.
 *
 * The models only accept fixed `windowSize`×`windowSize` patches, so a full
 * page is scanned as a grid of overlapping tiles (stride `stepSize`), each tile
 * inferred independently, then the per-tile softmax outputs are averaged back
 * onto the page where they overlap. This mirrors oemer's `inference()` sliding
 * window, including clamping the final row/column flush against the page edge.
 */

/** The top-left origin of one tile, in page pixels. */
export interface Tile {
  x: number;
  y: number;
}

/**
 * Lay out the tile grid covering a `width`×`height` page. Tiles step by
 * `stepSize`; the last tile in each axis is pulled back so it ends on the page
 * edge rather than overrunning it, exactly like oemer. Edge clamping can land
 * two iterations on the same origin — those exact duplicates are dropped since
 * they would contribute identical predictions to identical pixels.
 */
export function planTiles(
  width: number,
  height: number,
  windowSize: number,
  stepSize: number,
): Tile[] {
  const xs = axisOrigins(width, windowSize, stepSize);
  const ys = axisOrigins(height, windowSize, stepSize);
  const tiles: Tile[] = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/** Distinct, ascending tile origins along one axis of `length`. */
function axisOrigins(
  length: number,
  windowSize: number,
  stepSize: number,
): number[] {
  // A page smaller than one window is covered by a single origin at 0; callers
  // are expected to pad such inputs up to `windowSize` before cropping.
  if (length <= windowSize) {
    return [0];
  }
  const origins: number[] = [];
  for (let start = 0; start < length; start += stepSize) {
    const clamped = start + windowSize > length ? length - windowSize : start;
    if (origins[origins.length - 1] !== clamped) {
      origins.push(clamped);
    }
  }
  return origins;
}

/**
 * Whether a tile's source region is pure page background — every pixel is
 * lighter than `inkLuminance` (Rec. 601 luma). Printed notation is dark on a
 * light page, so such tiles contain no staff or symbols and segmentation can
 * skip them entirely (uncovered pixels finalize to the background class). Reads
 * past the page edge are clamped to the last valid pixel, exactly like
 * {@link cropPatch}, and the scan early-exits on the first ink pixel so
 * non-blank tiles cost almost nothing.
 */
export function isTileBlank(
  image: RgbaImage,
  tile: Tile,
  windowSize: number,
  inkLuminance: number,
): boolean {
  const { data, width, height } = image;
  for (let row = 0; row < windowSize; row++) {
    const sourceY = Math.min(tile.y + row, height - 1);
    for (let column = 0; column < windowSize; column++) {
      const sourceX = Math.min(tile.x + column, width - 1);
      const source = (sourceY * width + sourceX) * 4;
      const luma =
        data[source] * 0.299 +
        data[source + 1] * 0.587 +
        data[source + 2] * 0.114;
      if (luma < inkLuminance) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Extract a `windowSize`×`windowSize` RGB patch from `image` at `tile`, dropping
 * the alpha channel. Returns channel-last `uint8` data (`[h][w][3]`) ready to
 * stack into a model input batch. Reads past the page edge are clamped to the
 * last valid pixel so under-sized inputs still yield a full patch.
 */
export function cropPatch(
  image: RgbaImage,
  tile: Tile,
  windowSize: number,
): Uint8Array {
  const patch = new Uint8Array(windowSize * windowSize * 3);
  const { data, width, height } = image;
  for (let row = 0; row < windowSize; row++) {
    const sourceY = Math.min(tile.y + row, height - 1);
    for (let column = 0; column < windowSize; column++) {
      const sourceX = Math.min(tile.x + column, width - 1);
      const source = (sourceY * width + sourceX) * 4;
      const target = (row * windowSize + column) * 3;
      patch[target] = data[source];
      patch[target + 1] = data[source + 1];
      patch[target + 2] = data[source + 2];
    }
  }
  return patch;
}

/**
 * Running sum of overlapping tile predictions plus a per-pixel contribution
 * count, finalized into an averaged {@link ProbabilityMap}.
 */
export interface ProbabilityAccumulator {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly sums: Float32Array;
  readonly counts: Uint16Array;
}

export function createProbabilityAccumulator(
  width: number,
  height: number,
  channels: number,
): ProbabilityAccumulator {
  return {
    width,
    height,
    channels,
    sums: new Float32Array(width * height * channels),
    counts: new Uint16Array(width * height),
  };
}

/**
 * Add one tile's channel-last softmax patch (`[windowSize][windowSize][channels]`)
 * into the accumulator at `tile`, ignoring rows/columns that fall outside the
 * page (the clamped edge tiles legitimately point at in-bounds pixels, so this
 * only trims the padding of under-sized pages).
 */
export function addTilePrediction(
  accumulator: ProbabilityAccumulator,
  tile: Tile,
  patch: Float32Array,
  windowSize: number,
): void {
  const { width, height, channels, sums, counts } = accumulator;
  for (let row = 0; row < windowSize; row++) {
    const pageY = tile.y + row;
    if (pageY >= height) {
      break;
    }
    for (let column = 0; column < windowSize; column++) {
      const pageX = tile.x + column;
      if (pageX >= width) {
        break;
      }
      const pixel = pageY * width + pageX;
      const patchBase = (row * windowSize + column) * channels;
      const sumBase = pixel * channels;
      for (let channel = 0; channel < channels; channel++) {
        sums[sumBase + channel] += patch[patchBase + channel];
      }
      counts[pixel] += 1;
    }
  }
}

/** Divide accumulated sums by contribution counts to get mean probabilities. */
export function finalizeProbabilityMap(
  accumulator: ProbabilityAccumulator,
): ProbabilityMap {
  const { width, height, channels, sums, counts } = accumulator;
  const data = new Float32Array(width * height * channels);
  for (let pixel = 0; pixel < counts.length; pixel++) {
    const count = counts[pixel];
    if (count === 0) {
      continue;
    }
    const base = pixel * channels;
    for (let channel = 0; channel < channels; channel++) {
      data[base + channel] = sums[base + channel] / count;
    }
  }
  return { data, width, height, channels };
}
