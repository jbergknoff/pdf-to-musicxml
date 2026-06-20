import { describe, expect, it } from "bun:test";
import type { RgbaImage } from "../types";
import {
  addTilePrediction,
  createProbabilityAccumulator,
  cropPatch,
  finalizeProbabilityMap,
  isTileBlank,
  planTiles,
} from "./tiling";

/** Build a solid-gray RGBA image for blank-tile tests. */
function solidGrayImage(
  width: number,
  height: number,
  gray: number,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = gray;
    data[pixel * 4 + 1] = gray;
    data[pixel * 4 + 2] = gray;
    data[pixel * 4 + 3] = 255;
  }
  return { data, width, height };
}

describe("isTileBlank", () => {
  it("treats an all-white region as blank", () => {
    const image = solidGrayImage(8, 8, 255);
    expect(isTileBlank(image, { x: 0, y: 0 }, 8, 160)).toBe(true);
  });

  it("keeps a tile containing a single ink pixel", () => {
    const image = solidGrayImage(8, 8, 255);
    // One dark pixel at (3, 2).
    const source = (2 * 8 + 3) * 4;
    image.data[source] = 10;
    image.data[source + 1] = 10;
    image.data[source + 2] = 10;
    expect(isTileBlank(image, { x: 0, y: 0 }, 8, 160)).toBe(false);
  });

  it("keeps a light-gray tile only above the ink threshold", () => {
    expect(isTileBlank(solidGrayImage(8, 8, 200), { x: 0, y: 0 }, 8, 160)).toBe(
      true,
    );
    expect(isTileBlank(solidGrayImage(8, 8, 120), { x: 0, y: 0 }, 8, 160)).toBe(
      false,
    );
  });
});

describe("planTiles", () => {
  it("covers a page smaller than the window with a single origin", () => {
    expect(planTiles(100, 80, 256, 128)).toEqual([{ x: 0, y: 0 }]);
  });

  it("returns one tile when the page equals the window", () => {
    expect(planTiles(256, 256, 256, 128)).toEqual([{ x: 0, y: 0 }]);
  });

  it("clamps the final tile flush against the page edge", () => {
    // Window 256, step 128, width 400: origins 0, then 128 would overrun
    // (128 + 256 = 384 < 400 ok), then 256 overruns -> clamp to 400-256=144.
    const tiles = planTiles(400, 256, 256, 128);
    const xs = tiles.map((tile) => tile.x);
    expect(xs).toEqual([0, 128, 144]);
    // The last origin keeps the window inside the page.
    expect(144 + 256).toBe(400);
  });

  it("drops exact-duplicate origins produced by edge clamping", () => {
    // Width 300: starts 0, 128, 256(->clamp 44)... ensure no repeats and all
    // origins stay in-bounds.
    const tiles = planTiles(300, 300, 256, 128);
    const keys = tiles.map((tile) => `${tile.x},${tile.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tile of tiles) {
      expect(tile.x + 256).toBeLessThanOrEqual(300);
      expect(tile.y + 256).toBeLessThanOrEqual(300);
    }
  });
});

function solidImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    // Encode the pixel index into RGB so crops are identifiable; alpha varies
    // so we can confirm it is dropped.
    data[pixel * 4] = pixel % 256;
    data[pixel * 4 + 1] = (pixel * 2) % 256;
    data[pixel * 4 + 2] = (pixel * 3) % 256;
    data[pixel * 4 + 3] = 17;
  }
  return { data, width, height };
}

describe("cropPatch", () => {
  it("extracts an RGB patch and drops alpha", () => {
    const image = solidImage(4, 4);
    const patch = cropPatch(image, { x: 1, y: 1 }, 2);
    // Top-left of the patch is page pixel (1,1) = index 5.
    expect(patch[0]).toBe(5 % 256);
    expect(patch[1]).toBe((5 * 2) % 256);
    expect(patch[2]).toBe((5 * 3) % 256);
    expect(patch.length).toBe(2 * 2 * 3);
  });

  it("clamps reads past the page edge to the last pixel", () => {
    const image = solidImage(2, 2);
    const patch = cropPatch(image, { x: 1, y: 1 }, 2);
    // Origin (1,1) is the last pixel; every other patch cell reads past the edge
    // and clamps back to page pixel (1,1) = index 3.
    const pageIndex = 3;
    for (let cell = 0; cell < 4; cell++) {
      expect(patch[cell * 3]).toBe(pageIndex % 256);
    }
  });
});

describe("probability accumulator", () => {
  it("averages overlapping tile predictions", () => {
    const accumulator = createProbabilityAccumulator(3, 1, 2);
    // Tile A covers x=0..1 predicting [1,0]; tile B covers x=1..2 predicting
    // [0,1]. The shared pixel x=1 should average to [0.5, 0.5].
    addTilePrediction(
      accumulator,
      { x: 0, y: 0 },
      new Float32Array([1, 0, 1, 0]),
      2,
    );
    addTilePrediction(
      accumulator,
      { x: 1, y: 0 },
      new Float32Array([0, 1, 0, 1]),
      2,
    );
    const map = finalizeProbabilityMap(accumulator);
    expect(Array.from(map.data)).toEqual([1, 0, 0.5, 0.5, 0, 1]);
    expect(map.width).toBe(3);
    expect(map.channels).toBe(2);
  });

  it("ignores tile rows and columns outside the page", () => {
    const accumulator = createProbabilityAccumulator(2, 2, 1);
    // A 3x3 patch placed at the origin; only the top-left 2x2 is in-bounds.
    const patch = new Float32Array(9).fill(2);
    addTilePrediction(accumulator, { x: 0, y: 0 }, patch, 3);
    const map = finalizeProbabilityMap(accumulator);
    expect(Array.from(map.data)).toEqual([2, 2, 2, 2]);
  });
});
