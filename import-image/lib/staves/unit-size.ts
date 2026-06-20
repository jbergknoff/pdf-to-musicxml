/**
 * Estimating the unit size — the interline spacing of a staff, which is the
 * scale reference every later stage (note-head radius, stem length, ledger-line
 * spacing) measures against.
 *
 * Sorted staffline centers have small, regular gaps within a staff (four per
 * five-line staff) and a much larger gap between staves. Across a page the
 * within-staff gaps vastly outnumber the between-staff ones, so the median gap
 * is a robust estimate of the interline spacing even before the lines are
 * grouped into staves.
 */

/** Median of the consecutive gaps between sorted values. */
export function estimateUnitSize(centers: number[]): number {
  if (centers.length < 2) {
    return 0;
  }
  const sorted = [...centers].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index++) {
    gaps.push(sorted[index] - sorted[index - 1]);
  }
  return median(gaps);
}

/** Median of a non-empty list of numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}
