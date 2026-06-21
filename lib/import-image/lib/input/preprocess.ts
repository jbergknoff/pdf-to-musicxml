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

// Segmentation pixel budgets, chosen per inference provider. Segmentation time
// scales ~linearly with pixel count (tiles per page), so the budget is the main
// speed/accuracy knob.
//
// At a low budget a staffline is only ~1px thin — right on the model's argmax
// decision boundary, where the WebGPU EP's small numerical differences from WASM
// drop enough line pixels to lose whole staves (see AGENTS.md "Execution
// provider split"). A higher budget thickens the lines off that boundary and
// puts the page back in oemer's ~3–4.35 M px training band. WebGPU is fast enough
// per tile to afford that; WASM (~6× slower per tile) is not, so it stays at the
// speed-compromised budget.
export const SEGMENTATION_PIXEL_BUDGET = {
  webgpu: 3_000_000,
  wasm: 1_000_000,
} as const;

// Default budget for callers that do not pass one (e.g. tests, the resolution
// comparison harness). Matches the WASM budget — the conservative, fast floor.
const DEFAULT_PIXEL_BUDGET = SEGMENTATION_PIXEL_BUDGET.wasm;

/**
 * Rescale `image` so its pixel count lands at `targetPixels` (oemer's training
 * band is ~3–4.35 M px). Returns the original image unchanged when it is already
 * at the target; otherwise scales both dimensions by a single ratio using
 * bilinear sampling. The budget is provider-dependent — see
 * {@link SEGMENTATION_PIXEL_BUDGET}.
 */
export function resizeToPixelBudget(
  image: RgbaImage,
  targetPixels: number = DEFAULT_PIXEL_BUDGET,
): RgbaImage {
  const pixels = image.width * image.height;
  if (pixels === targetPixels) {
    return image;
  }
  const ratio = Math.sqrt(targetPixels / pixels);
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
