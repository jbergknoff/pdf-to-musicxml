/**
 * Extracts a raster strip for one detected staff from the full-page image and
 * converts it to the float32 grayscale format TrOMR expects.
 */
import type { RgbaImage, Staff } from "../types";

/** Fixed input dimensions the TrOMR encoder ONNX was exported at. */
export const TROMR_INPUT_HEIGHT = 256;
export const TROMR_INPUT_WIDTH = 1280;

/**
 * Per-pixel normalization TrOMR was trained with (homr `ConvertToArray`):
 * after scaling pixels to [0, 1], apply `(value - mean) / std`. These exact
 * constants matter — the encoder sees the wrong input distribution without
 * them, which transcribes detected staves into plausible-but-wrong notes.
 */
export const TROMR_NORM_MEAN = 0.7931;
export const TROMR_NORM_STD = 0.1738;

/** The normalized value of a white (background) pixel: (1 - mean) / std. */
export const TROMR_NORM_WHITE = (1 - TROMR_NORM_MEAN) / TROMR_NORM_STD;

/**
 * Crop the bounding band for one staff from `image`, adding vertical padding
 * proportional to the staff's unit size so ledger-line notes above and below
 * the staff are included.
 */
export function cropStaff(image: RgbaImage, staff: Staff): RgbaImage {
  const padding = Math.round(staff.unitSize * 2.5);
  const top = Math.max(0, Math.floor(staff.lines[0]) - padding);
  const bottom = Math.min(
    image.height - 1,
    Math.ceil(staff.lines[staff.lines.length - 1]) + padding,
  );
  const left = Math.max(0, staff.left);
  const right = Math.min(image.width - 1, staff.right);

  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = ((top + y) * image.width + (left + x)) * 4;
      const destination = (y * width + x) * 4;
      data[destination] = image.data[source];
      data[destination + 1] = image.data[source + 1];
      data[destination + 2] = image.data[source + 2];
      data[destination + 3] = image.data[source + 3];
    }
  }
  return { data, width, height };
}

/**
 * Resize an RGBA image to the given exact dimensions using bilinear
 * interpolation. Does not preserve aspect ratio — the caller is responsible
 * for computing the target size.
 */
function resizeToSize(
  image: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): RgbaImage {
  const scaleX = targetWidth / image.width;
  const scaleY = targetHeight / image.height;
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y++) {
    const sourceY = y / scaleY;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const yFraction = sourceY - y0;

    for (let x = 0; x < targetWidth; x++) {
      const sourceX = x / scaleX;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const xFraction = sourceX - x0;

      for (let channel = 0; channel < 4; channel++) {
        const top0 = image.data[(y0 * image.width + x0) * 4 + channel];
        const top1 = image.data[(y0 * image.width + x1) * 4 + channel];
        const bottom0 = image.data[(y1 * image.width + x0) * 4 + channel];
        const bottom1 = image.data[(y1 * image.width + x1) * 4 + channel];
        const value =
          top0 * (1 - xFraction) * (1 - yFraction) +
          top1 * xFraction * (1 - yFraction) +
          bottom0 * (1 - xFraction) * yFraction +
          bottom1 * xFraction * yFraction;
        data[(y * targetWidth + x) * 4 + channel] = Math.round(value);
      }
    }
  }
  return { data, width: targetWidth, height: targetHeight };
}

/**
 * Prepare a cropped staff strip for TrOMR inference, matching homr's
 * `get_tr_omr_canvas_size` + `center_image_on_canvas` + `ConvertToArray`:
 *
 *   1. Scale to fit within [targetHeight × targetWidth] preserving aspect ratio.
 *   2. Place left-aligned and **vertically centered** on a white canvas (the
 *      model reads pitch from absolute vertical position, so centering — not
 *      top-aligning — is what keeps pitches correct).
 *   3. Convert to grayscale, scale to [0, 1], then normalize:
 *      `(value - TROMR_NORM_MEAN) / TROMR_NORM_STD`.
 *
 * Returns a Float32Array in row-major order for a [1, 1, H, W] NCHW tensor.
 */
export function prepareStaffTensor(
  image: RgbaImage,
  targetHeight = TROMR_INPUT_HEIGHT,
  targetWidth = TROMR_INPUT_WIDTH,
): { data: Float32Array; width: number } {
  // Scale to fit within the bounding box maintaining aspect ratio.
  const scale = Math.min(
    targetHeight / image.height,
    targetWidth / image.width,
  );
  const scaledHeight = Math.max(1, Math.round(image.height * scale));
  const scaledWidth = Math.max(1, Math.round(image.width * scale));

  const resized = resizeToSize(image, scaledWidth, scaledHeight);

  // Fill with normalized white (background), then copy the scaled content in,
  // left-aligned and vertically centered, leaving the margins as white padding.
  const data = new Float32Array(targetHeight * targetWidth).fill(
    TROMR_NORM_WHITE,
  );
  const yOffset = Math.floor((targetHeight - scaledHeight) / 2);

  for (let y = 0; y < scaledHeight; y++) {
    const destinationRow = (yOffset + y) * targetWidth;
    for (let x = 0; x < scaledWidth; x++) {
      const r = resized.data[(y * scaledWidth + x) * 4];
      const g = resized.data[(y * scaledWidth + x) * 4 + 1];
      const b = resized.data[(y * scaledWidth + x) * 4 + 2];
      // ITU-R BT.601 luma scaled to [0, 1], then TrOMR mean/std normalization.
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      data[destinationRow + x] = (luma - TROMR_NORM_MEAN) / TROMR_NORM_STD;
    }
  }

  return { data, width: targetWidth };
}
