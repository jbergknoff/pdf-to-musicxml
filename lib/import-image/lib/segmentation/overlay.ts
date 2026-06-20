import type { Mask, RgbaImage } from "../types";

/**
 * Compositing segmentation masks back onto the page for visual inspection — the
 * Phase 1 deliverable is "masks overlaid on page". This is a pure raster
 * operation over {@link RgbaImage} so it can run anywhere and be unit-tested;
 * the browser just blits the result onto a canvas.
 */

export type Color = readonly [number, number, number];

export interface OverlayLayer {
  mask: Mask;
  color: Color;
}

/**
 * Alpha-blend each layer's color over `base` wherever that layer's mask is set.
 * Layers are applied in order, so later layers paint over earlier ones. Every
 * mask must match `base`'s dimensions. Returns a new image; `base` is untouched.
 */
export function compositeMasks(
  base: RgbaImage,
  layers: OverlayLayer[],
  alpha = 0.5,
): RgbaImage {
  const data = new Uint8ClampedArray(base.data);
  for (const { mask, color } of layers) {
    if (mask.width !== base.width || mask.height !== base.height) {
      throw new Error(
        `Mask ${mask.width}x${mask.height} does not match image ${base.width}x${base.height}`,
      );
    }
    for (let pixel = 0; pixel < mask.data.length; pixel++) {
      if (mask.data[pixel] === 0) {
        continue;
      }
      const offset = pixel * 4;
      data[offset] = data[offset] * (1 - alpha) + color[0] * alpha;
      data[offset + 1] = data[offset + 1] * (1 - alpha) + color[1] * alpha;
      data[offset + 2] = data[offset + 2] * (1 - alpha) + color[2] * alpha;
    }
  }
  return { data, width: base.width, height: base.height };
}

/**
 * Wash `image` toward white by `amount` in [0, 1] (0 = unchanged, 1 = pure
 * white), leaving alpha intact. Used to fade the page behind the overlay so the
 * colored masks read clearly against the printed ink rather than competing with
 * it. Returns a new image; `base` is untouched.
 */
export function fadeToWhite(image: RgbaImage, amount: number): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = data[offset] * (1 - amount) + 255 * amount;
    data[offset + 1] = data[offset + 1] * (1 - amount) + 255 * amount;
    data[offset + 2] = data[offset + 2] * (1 - amount) + 255 * amount;
  }
  return { data, width: image.width, height: image.height };
}
