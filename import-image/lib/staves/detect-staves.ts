import type { Mask, Staff, StaffStructure } from "../types";
import { detectStafflineRows } from "./staffline-detection";
import { estimateUnitSize, median } from "./unit-size";

/**
 * Phase 2 staff-structure detection: turn the staff mask into a list of
 * five-line staves with their interline spacing and horizontal extent.
 *
 * It detects every staffline by horizontal projection, estimates the page's
 * unit size from the gaps between them, then walks the lines top to bottom and
 * cuts a new staff whenever five lines have accumulated or a gap far larger
 * than the unit size appears (the space between staves). Groups that do not end
 * up with exactly five lines are dropped as noise. For each kept staff the
 * horizontal extent comes from a vertical projection over the staff's own row
 * band, so neighbouring staves do not bleed in.
 */

const STANDARD_STAFF_LINES = 5;

export interface DetectStavesOptions {
  /**
   * Lines separated by more than this multiple of the unit size start a new
   * staff. Within-staff gaps are ~1 unit; the gap to the next staff is several,
   * so anything comfortably above 1 cleanly splits staves while tolerating
   * slightly uneven line spacing.
   */
  maxLineGapFactor?: number;
  /** Forwarded to {@link detectStafflineRows}. */
  thresholdFraction?: number;
}

export function detectStaves(
  staffMask: Mask,
  options: DetectStavesOptions = {},
): StaffStructure {
  const { maxLineGapFactor = 1.7, thresholdFraction } = options;

  const rows = detectStafflineRows(staffMask, { thresholdFraction });
  if (rows.length < STANDARD_STAFF_LINES) {
    return { staves: [], unitSize: 0 };
  }

  const centers = rows.map((row) => row.center);
  const unitSize = estimateUnitSize(centers);
  const maxGap = unitSize * maxLineGapFactor;

  // Cut the sorted lines into candidate staves at large gaps or every fifth
  // line, whichever comes first.
  const groups: number[][] = [];
  let current: number[] = [];
  for (const center of centers) {
    const previous = current[current.length - 1];
    const startsNewStaff =
      current.length >= STANDARD_STAFF_LINES ||
      (current.length > 0 && center - previous > maxGap);
    if (startsNewStaff) {
      groups.push(current);
      current = [];
    }
    current.push(center);
  }
  if (current.length > 0) {
    groups.push(current);
  }

  const staves: Staff[] = [];
  for (const lines of groups) {
    if (lines.length !== STANDARD_STAFF_LINES) {
      continue;
    }
    const lineGaps: number[] = [];
    for (let index = 1; index < lines.length; index++) {
      lineGaps.push(lines[index] - lines[index - 1]);
    }
    const staffUnitSize = median(lineGaps);
    const extent = horizontalExtent(staffMask, lines, staffUnitSize);
    if (extent === null) {
      continue;
    }
    staves.push({
      lines,
      unitSize: staffUnitSize,
      left: extent.left,
      right: extent.right,
    });
  }

  return {
    staves,
    unitSize: staves.length > 0 ? median(staves.map((s) => s.unitSize)) : 0,
  };
}

/**
 * Leftmost and rightmost columns carrying staffline pixels, measured over the
 * rows this staff spans (padded by half a unit so line thickness is included).
 * A column is part of the staff if it intersects at least half of the five
 * lines, which keeps stray marks from stretching the extent. Returns null when
 * no column qualifies.
 */
function horizontalExtent(
  mask: Mask,
  lines: number[],
  unitSize: number,
): { left: number; right: number } | null {
  const { data, width, height } = mask;
  const pad = unitSize * 0.5;
  const topRow = Math.max(0, Math.floor(lines[0] - pad));
  const bottomRow = Math.min(
    height - 1,
    Math.ceil(lines[lines.length - 1] + pad),
  );
  const columnThreshold = lines.length * 0.5;

  let left = -1;
  let right = -1;
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = topRow; y <= bottomRow; y++) {
      count += data[y * width + x];
    }
    if (count >= columnThreshold) {
      if (left === -1) {
        left = x;
      }
      right = x;
    }
  }
  if (left === -1) {
    return null;
  }
  return { left, right };
}
