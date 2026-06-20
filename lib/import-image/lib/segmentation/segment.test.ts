import { describe, expect, it } from "bun:test";
import type { InferenceSession } from "../runtime/inference-backend";
import type { RgbaImage } from "../types";
import {
  createSegmentationModels,
  segment,
  SYMBOL_DETAIL_MODEL_SPEC,
} from "./segment";
import { runSegmentationModel } from "./unet-session";

/**
 * A fake session that emits a one-hot softmax for `targetClass` at every pixel,
 * ignoring the actual patch contents. It reads the batch/window dimensions from
 * the input so it works for either model geometry.
 */
function constantClassSession(
  outputName: string,
  channels: number,
  targetClass: number,
): InferenceSession {
  return {
    inputNames: ["input"],
    async run(feeds) {
      const input = Object.values(feeds)[0];
      const [batch, windowSize] = input.dims;
      const data = new Float32Array(batch * windowSize * windowSize * channels);
      for (let pixel = 0; pixel < batch * windowSize * windowSize; pixel++) {
        data[pixel * channels + targetClass] = 1;
      }
      return {
        [outputName]: {
          type: "float32",
          data,
          dims: [batch, windowSize, windowSize, channels],
        },
      };
    },
  };
}

function blankImage(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

describe("runSegmentationModel", () => {
  it("produces a full-resolution probability map and reports progress", async () => {
    const progress: number[] = [];
    const image = blankImage(400, 320);
    const map = await runSegmentationModel(
      image,
      {
        spec: SYMBOL_DETAIL_MODEL_SPEC,
        session: constantClassSession(
          SYMBOL_DETAIL_MODEL_SPEC.outputName,
          SYMBOL_DETAIL_MODEL_SPEC.channels,
          2,
        ),
      },
      { batchSize: 2, onProgress: (fraction) => progress.push(fraction) },
    );

    expect(map.width).toBe(400);
    expect(map.height).toBe(320);
    expect(map.channels).toBe(4);
    // Every pixel is covered, so the averaged map is the one-hot we emitted.
    for (let pixel = 0; pixel < map.width * map.height; pixel++) {
      expect(map.data[pixel * 4 + 2]).toBe(1);
    }
    expect(progress.at(-1)).toBe(1);
  });
});

describe("segment", () => {
  it("maps each model's classes onto the named masks", async () => {
    const image = blankImage(300, 260);
    const models = createSegmentationModels(
      // unet_big: class 1 == staff.
      constantClassSession("prediction", 3, 1),
      // seg_net: class 2 == noteheads.
      constantClassSession("conv2d_25", 4, 2),
    );

    const masks = await segment(image, models, { batchSize: 3 });

    expect(masks.width).toBe(300);
    expect(masks.height).toBe(260);
    const allOnes = (mask: { data: Uint8Array }) =>
      mask.data.every((value) => value === 1);
    const allZeros = (mask: { data: Uint8Array }) =>
      mask.data.every((value) => value === 0);

    expect(allOnes(masks.staff)).toBe(true);
    expect(allZeros(masks.symbols)).toBe(true);
    expect(allOnes(masks.noteheads)).toBe(true);
    expect(allZeros(masks.stemsRests)).toBe(true);
    expect(allZeros(masks.clefsKeys)).toBe(true);
  });

  it("threads progress across both models from 0 to 1", async () => {
    const image = blankImage(300, 260);
    const models = createSegmentationModels(
      constantClassSession("prediction", 3, 1),
      constantClassSession("conv2d_25", 4, 2),
    );
    const progress: number[] = [];
    await segment(image, models, {
      onProgress: (fraction) => progress.push(fraction),
    });
    expect(progress[0]).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    // Progress is monotonically non-decreasing.
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  });
});
