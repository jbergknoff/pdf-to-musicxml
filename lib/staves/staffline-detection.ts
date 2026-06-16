import type { Mask } from "../types";

/**
 * Locating stafflines in the staff mask via horizontal projection.
 *
 * Stafflines are long, near-horizontal runs, so summing the staff mask across
 * each row yields a profile that spikes wherever a staffline sits and is near
 * zero between lines. Thresholding that profile and grouping the surviving rows
 * into runs recovers one entry per staffline, with a sub-pixel center. This is
 * the first step of Phase 2 staff-structure detection; grouping the lines into
 * five-line staves and estimating the unit size build on it.
 */

/** A single detected staffline: its (fractional) center row and thickness. */
export interface StafflineRow {
  /** Center row (y) of the staffline, in mask pixels. */
  center: number;
  /** Vertical thickness of the staffline, in rows. */
  thickness: number;
}

/** Count of set pixels in each row of the mask (length = `mask.height`). */
export function horizontalProjection(mask: Mask): Float32Array {
  const { data, width, height } = mask;
  const projection = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let count = 0;
    for (let x = 0; x < width; x++) {
      count += data[rowStart + x];
    }
    projection[y] = count;
  }
  return projection;
}

export interface DetectStafflineRowsOptions {
  /**
   * A row counts as staffline if its projection is at least this fraction of
   * the page's peak row count. Stafflines dominate the staff mask, so a low
   * threshold separates them cleanly from the near-empty rows between.
   */
  thresholdFraction?: number;
}

/**
 * Detect staffline row centers from a staff mask. Rows whose horizontal
 * projection clears the threshold are grouped into contiguous runs; each run
 * becomes one staffline whose center is the projection-weighted centroid of the
 * run (so a two-pixel-thick line lands halfway between its rows). Returns the
 * lines ordered top to bottom.
 */
export function detectStafflineRows(
  mask: Mask,
  options: DetectStafflineRowsOptions = {},
): StafflineRow[] {
  const { thresholdFraction = 0.25 } = options;
  const projection = horizontalProjection(mask);

  let peak = 0;
  for (const count of projection) {
    if (count > peak) {
      peak = count;
    }
  }
  if (peak === 0) {
    return [];
  }
  const threshold = peak * thresholdFraction;

  const rows: StafflineRow[] = [];
  let runStart = -1;
  // Walk one past the end so a run that reaches the final row still closes.
  for (let y = 0; y <= projection.length; y++) {
    const aboveThreshold = y < projection.length && projection[y] >= threshold;
    if (aboveThreshold && runStart === -1) {
      runStart = y;
    } else if (!aboveThreshold && runStart !== -1) {
      let weightSum = 0;
      let weightedRowSum = 0;
      for (let row = runStart; row < y; row++) {
        weightSum += projection[row];
        weightedRowSum += projection[row] * row;
      }
      rows.push({
        center: weightedRowSum / weightSum,
        thickness: y - runStart,
      });
      runStart = -1;
    }
  }
  return rows;
}
