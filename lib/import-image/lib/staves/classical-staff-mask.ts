import type { Mask, RgbaImage } from "../types";

/**
 * Classical (model-free) staff-line mask, a drop-in replacement for the oemer
 * `unet_big` staff mask that feeds {@link detectStaves}.
 *
 * For *born-digital* sheet music (clean, high-contrast, axis-aligned), stafflines
 * are simply the long horizontal ink runs, so they can be isolated without a
 * neural net:
 *
 *   1. Binarize the page to ink/background with Otsu's threshold.
 *   2. Estimate the staff space (interline gap) scale-invariantly from the most
 *      common vertical white-run length — the classic OMR "reference length".
 *   3. Keep only ink pixels that belong to a horizontal run longer than a small
 *      multiple of that staff space. Stafflines survive (they run across the
 *      staff between symbols); noteheads, stems, beams, and text do not.
 *
 * The result is the same `Mask` shape the segmentation models emit (binary 0/1,
 * row-major), in the same coordinate space as the input raster, so everything
 * downstream (`detectStaves`, the staff crops, TrOMR) is unchanged. This is the
 * fast, weight-free path for the common case; the UNet stays available for the
 * hard inputs (photos, skew) classical CV does not handle.
 */

export interface ClassicalStaffMaskOptions {
  /**
   * A pixel counts as ink when its luma (0–255) is at most this value. Defaults
   * to Otsu's automatically chosen threshold for the page.
   */
  inkThreshold?: number;
  /**
   * Minimum horizontal run length to keep, as a multiple of the estimated staff
   * space. A staffline segment between two symbols is several staff spaces long,
   * while a notehead is about one, so a value between 1 and 2 separates them.
   */
  minRunSpaceFactor?: number;
}

/** ITU-R BT.601 luma (0–255) of an RGBA pixel at byte offset `index`. */
function lumaAt(data: Uint8ClampedArray, index: number): number {
  return Math.round(
    0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2],
  );
}

/**
 * Otsu's method: the luma threshold (0–255) that maximizes between-class
 * variance, i.e. best separates the dark (ink) and light (paper) pixel
 * populations of a bimodal page.
 */
export function otsuThreshold(histogram: Int32Array, total: number): number {
  let sum = 0;
  for (let level = 0; level < 256; level++) {
    sum += level * histogram[level];
  }

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let level = 0; level < 256; level++) {
    backgroundWeight += histogram[level];
    if (backgroundWeight === 0) {
      continue;
    }
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) {
      break;
    }
    backgroundSum += level * histogram[level];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const meanDifference = backgroundMean - foregroundMean;
    const variance =
      backgroundWeight * foregroundWeight * meanDifference * meanDifference;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = level;
    }
  }
  return bestThreshold;
}

/**
 * Estimate the staff space (interline gap, in pixels) as the most common length
 * of a vertical white run bounded by ink above and below — the gaps between
 * adjacent stafflines dominate that distribution on engraved music. Returns 0
 * when no bounded gap is found (a blank or non-music page).
 */
export function estimateStaffSpace(ink: Uint8Array, width: number, height: number): number {
  // Cap the histogram: real staff spaces are small relative to the page, and
  // ignoring huge runs (margins, between-staff gaps) keeps the mode on the
  // interline gap.
  const maxGap = Math.max(4, Math.floor(height / 4));
  const histogram = new Int32Array(maxGap + 1);
  for (let x = 0; x < width; x++) {
    let runLength = 0;
    let sawInkAbove = false;
    for (let y = 0; y < height; y++) {
      if (ink[y * width + x] === 1) {
        if (sawInkAbove && runLength > 0 && runLength <= maxGap) {
          histogram[runLength]++;
        }
        sawInkAbove = true;
        runLength = 0;
      } else {
        runLength++;
      }
    }
  }

  let bestLength = 0;
  let bestCount = 0;
  for (let length = 1; length <= maxGap; length++) {
    if (histogram[length] > bestCount) {
      bestCount = histogram[length];
      bestLength = length;
    }
  }
  return bestLength;
}

export function classicalStaffMask(
  image: RgbaImage,
  options: ClassicalStaffMaskOptions = {},
): Mask {
  const { data, width, height } = image;
  const pixelCount = width * height;

  // 1) Binarize with Otsu (or a caller-supplied threshold).
  const histogram = new Int32Array(256);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    histogram[lumaAt(data, pixel * 4)]++;
  }
  const inkThreshold = options.inkThreshold ?? otsuThreshold(histogram, pixelCount);

  const ink = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    ink[pixel] = lumaAt(data, pixel * 4) <= inkThreshold ? 1 : 0;
  }

  // 2) Reference length: staff space → minimum horizontal run to keep.
  const { minRunSpaceFactor = 1.5 } = options;
  const staffSpace = estimateStaffSpace(ink, width, height);
  const minRun = Math.max(3, Math.round((staffSpace || 1) * minRunSpaceFactor));

  // 3) Keep ink that lies in a long horizontal run (a staffline), drop the rest.
  const mask = new Uint8Array(pixelCount);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const isInk = x < width && ink[rowStart + x] === 1;
      if (isInk && runStart === -1) {
        runStart = x;
      } else if (!isInk && runStart !== -1) {
        if (x - runStart >= minRun) {
          for (let fill = runStart; fill < x; fill++) {
            mask[rowStart + fill] = 1;
          }
        }
        runStart = -1;
      }
    }
  }

  return { data: mask, width, height };
}
