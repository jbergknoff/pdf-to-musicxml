import { describe, expect, it } from "bun:test";
import type { Mask } from "../types";
import {
  detectStafflineRows,
  horizontalProjection,
} from "./staffline-detection";

/** Build an empty mask and draw horizontal lines at the given rows. */
function maskWithLines(
  width: number,
  height: number,
  lines: { row: number; from: number; to: number; thickness?: number }[],
): Mask {
  const data = new Uint8Array(width * height);
  for (const { row, from, to, thickness = 1 } of lines) {
    for (let dy = 0; dy < thickness; dy++) {
      const y = row + dy;
      for (let x = from; x <= to; x++) {
        data[y * width + x] = 1;
      }
    }
  }
  return { data, width, height };
}

describe("horizontalProjection", () => {
  it("counts set pixels per row", () => {
    const mask = maskWithLines(10, 4, [{ row: 1, from: 2, to: 6 }]);
    expect(Array.from(horizontalProjection(mask))).toEqual([0, 5, 0, 0]);
  });
});

describe("detectStafflineRows", () => {
  it("finds one center per thin staffline", () => {
    const mask = maskWithLines(40, 30, [
      { row: 5, from: 4, to: 35 },
      { row: 9, from: 4, to: 35 },
      { row: 13, from: 4, to: 35 },
    ]);
    const rows = detectStafflineRows(mask);
    expect(rows.map((row) => row.center)).toEqual([5, 9, 13]);
    expect(rows.map((row) => row.thickness)).toEqual([1, 1, 1]);
  });

  it("places the center between the rows of a thick line", () => {
    const mask = maskWithLines(40, 20, [
      { row: 8, from: 4, to: 35, thickness: 2 },
    ]);
    const rows = detectStafflineRows(mask);
    expect(rows).toHaveLength(1);
    expect(rows[0].center).toBeCloseTo(8.5);
    expect(rows[0].thickness).toBe(2);
  });

  it("ignores faint rows below the threshold", () => {
    // One full-width line plus a short smudge that stays under 25% of the peak.
    const mask = maskWithLines(40, 20, [
      { row: 6, from: 0, to: 39 },
      { row: 12, from: 0, to: 4 },
    ]);
    const rows = detectStafflineRows(mask);
    expect(rows.map((row) => row.center)).toEqual([6]);
  });

  it("returns nothing for an empty mask", () => {
    const mask = maskWithLines(10, 10, []);
    expect(detectStafflineRows(mask)).toEqual([]);
  });
});
