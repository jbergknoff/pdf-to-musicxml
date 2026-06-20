import type { RgbaImage } from "../types";

/**
 * Image preprocessing for segmentation.
 *
 * oemer's models were trained on pages rescaled to a ~3–4.35 M px band, and the
 * model's receptive field / unit size assume that scale. Segmentation time
 * scales ~linearly with pixel count (tiles per page), so we deliberately run
 * *below* the training band to trade some recognition accuracy for a large
 * WebGPU speedup: smaller pages mean fewer tiles. Larger pages are downscaled to
 * the budget and tiny ones upscaled to it; pages already at it pass untouched.
 */

// 1 M px — well under oemer's 3 M px training floor. This is a speed/accuracy
// knob: lower is faster (fewer tiles) but shrinks notation relative to the
// model's receptive field, so very small symbols start to be missed. Raise it
// back toward 3 M px to recover accuracy at the cost of speed.
const MINIMUM_PIXELS = 1_000_000;
const MAXIMUM_PIXELS = 1_000_000;
const TARGET_PIXELS = 1_000_000;

/**
 * Rescale `image` so its pixel count lands in oemer's training band. Returns the
 * original image unchanged when it is already within `[MINIMUM_PIXELS,
 * MAXIMUM_PIXELS]`; otherwise scales both dimensions by a single ratio toward
 * `TARGET_PIXELS` using bilinear sampling.
 */
export function resizeToPixelBudget(image: RgbaImage): RgbaImage {
  const pixels = image.width * image.height;
  if (pixels >= MINIMUM_PIXELS && pixels <= MAXIMUM_PIXELS) {
    return image;
  }
  const ratio = Math.sqrt(TARGET_PIXELS / pixels);
  const targetWidth = Math.max(1, Math.round(image.width * ratio));
  const targetHeight = Math.max(1, Math.round(image.height * ratio));
  return resize(image, targetWidth, targetHeight);
}

/** Resize an RGBA image to exact dimensions with bilinear interpolation. */
export function resize(
  image: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): RgbaImage {
  if (targetWidth === image.width && targetHeight === image.height) {
    return image;
  }
  const { data, width, height } = image;
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  // Map output pixel centers back into the source grid. Guard the 1-pixel case
  // to avoid dividing by zero.
  const scaleX = targetWidth > 1 ? (width - 1) / (targetWidth - 1) : 0;
  const scaleY = targetHeight > 1 ? (height - 1) / (targetHeight - 1) : 0;

  for (let y = 0; y < targetHeight; y++) {
    const sourceY = y * scaleY;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, height - 1);
    const weightY = sourceY - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = x * scaleX;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, width - 1);
      const weightX = sourceX - x0;

      const topLeft = (y0 * width + x0) * 4;
      const topRight = (y0 * width + x1) * 4;
      const bottomLeft = (y1 * width + x0) * 4;
      const bottomRight = (y1 * width + x1) * 4;
      const outputIndex = (y * targetWidth + x) * 4;

      for (let channel = 0; channel < 4; channel++) {
        const top =
          data[topLeft + channel] * (1 - weightX) +
          data[topRight + channel] * weightX;
        const bottom =
          data[bottomLeft + channel] * (1 - weightX) +
          data[bottomRight + channel] * weightX;
        output[outputIndex + channel] = top * (1 - weightY) + bottom * weightY;
      }
    }
  }

  return { data: output, width: targetWidth, height: targetHeight };
}
