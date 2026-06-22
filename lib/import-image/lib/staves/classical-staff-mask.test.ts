import { describe, expect, it } from "bun:test";
import type { RgbaImage } from "../types";
import {
  classicalStaffMask,
  estimateStaffSpace,
  otsuThreshold,
} from "./classical-staff-mask";
import { detectStaves } from "./detect-staves";

/** White RGBA canvas; `draw` paints black ink rectangles onto it. */
function image(
  width: number,
  height: number,
  rects: { x0: number; x1: number; y0: number; y1: number }[],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const { x0, x1, y0, y1 } of rects) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const offset = (y * width + x) * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
      }
    }
  }
  return { data, width, height };
}

/** Five evenly spaced full-width stafflines at the given unit (line gap). */
function staffLines(
  width: number,
  top: number,
  unit: number,
  from = 0,
  to = width - 1,
) {
  return Array.from({ length: 5 }, (_, line) => ({
    x0: from,
    x1: to,
    y0: top + line * unit,
    y1: top + line * unit,
  }));
}

describe("otsuThreshold", () => {
  it("lands between the dark and light peaks of a bimodal page", () => {
    const histogram = new Int32Array(256);
    histogram[10] = 100; // ink
    histogram[240] = 900; // paper
    const threshold = otsuThreshold(histogram, 1000);
    // Ink (luma 10) must classify as ink (luma <= threshold) and paper (240) must not.
    expect(threshold).toBeGreaterThanOrEqual(10);
    expect(threshold).toBeLessThan(240);
  });
});

describe("estimateStaffSpace", () => {
  it("recovers the interline gap as the most common bounded white run", () => {
    const width = 60;
    const height = 60;
    const unit = 8;
    const mask = classicalStaffMask(image(width, height, staffLines(width, 10, unit)));
    // The gap between lines is unit-1 white rows; estimate should be near it.
    const space = estimateStaffSpace(mask.data, width, height);
    expect(space).toBeGreaterThanOrEqual(unit - 2);
    expect(space).toBeLessThanOrEqual(unit + 1);
  });
});

describe("classicalStaffMask", () => {
  it("keeps long horizontal lines and drops short symbol blobs", () => {
    const width = 80;
    const height = 40;
    // A full-width line at row 20, plus a small 6px-wide notehead blob at row 30.
    const img = image(width, height, [
      { x0: 0, x1: width - 1, y0: 20, y1: 20 },
      ...staffLines(width, 4, 6), // give estimateStaffSpace a real interline gap
      { x0: 10, x1: 15, y0: 35, y1: 37 },
    ]);
    const mask = classicalStaffMask(img);
    // The line row is kept.
    expect(mask.data[20 * width + 40]).toBe(1);
    // The blob is dropped (its 6px run is shorter than the kept-run threshold).
    expect(mask.data[36 * width + 12]).toBe(0);
  });

  it("feeds detectStaves to recover a five-line staff", () => {
    const width = 200;
    const height = 80;
    const unit = 10;
    const top = 15;
    const img = image(width, height, [
      ...staffLines(width, top, unit, 5, width - 6),
      // A couple of noteheads sitting on the staff — must not break detection.
      { x0: 40, x1: 47, y0: top + unit - 4, y1: top + unit + 4 },
      { x0: 120, x1: 127, y0: top + 2 * unit - 4, y1: top + 2 * unit + 4 },
    ]);
    const structure = detectStaves(classicalStaffMask(img));
    expect(structure.staves).toHaveLength(1);
    expect(structure.staves[0].lines).toHaveLength(5);
    expect(structure.unitSize).toBeCloseTo(unit, 0);
  });
});
