import type { Mask, ProbabilityMap } from "../types";

/**
 * Turning probability maps into binary masks.
 *
 * Each segmentation model emits a channel-last softmax; the predicted class at a
 * pixel is the argmax over its channels (channel 0 is always background). A mask
 * for class `k` is the set of pixels whose argmax is `k`, matching oemer's
 * `np.where(class_map == k, 1, 0)`.
 */

/** Per-pixel predicted class index (argmax over channels), row-major. */
export function argmaxClassMap(probabilities: ProbabilityMap): Uint8Array {
  const { data, width, height, channels } = probabilities;
  const classMap = new Uint8Array(width * height);
  for (let pixel = 0; pixel < classMap.length; pixel++) {
    const base = pixel * channels;
    let bestChannel = 0;
    let bestValue = data[base];
    for (let channel = 1; channel < channels; channel++) {
      const value = data[base + channel];
      if (value > bestValue) {
        bestValue = value;
        bestChannel = channel;
      }
    }
    classMap[pixel] = bestChannel;
  }
  return classMap;
}

/** Binary mask of the pixels assigned to `classIndex` in a class map. */
export function classMask(
  classMap: Uint8Array,
  width: number,
  height: number,
  classIndex: number,
): Mask {
  const data = new Uint8Array(width * height);
  for (let pixel = 0; pixel < data.length; pixel++) {
    data[pixel] = classMap[pixel] === classIndex ? 1 : 0;
  }
  return { data, width, height };
}
