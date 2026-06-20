import { describe, expect, it } from "bun:test";
import type { Mask } from "../types";
import { detectStaves } from "./detect-staves";

/** Draw `count` evenly spaced full-staff lines starting at `top`. */
function staffLines(
  top: number,
  spacing: number,
  from: number,
  to: number,
  count = 5,
): { row: number; from: number; to: number }[] {
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push({ row: top + index * spacing, from, to });
  }
  return lines;
}

function maskWithLines(
  width: number,
  height: number,
  lines: { row: number; from: number; to: number }[],
): Mask {
  const data = new Uint8Array(width * height);
  for (const { row, from, to } of lines) {
    for (let x = from; x <= to; x++) {
      data[row * width + x] = 1;
    }
  }
  return { data, width, height };
}

describe("detectStaves", () => {
  it("detects a single staff with its unit size and extent", () => {
    const mask = maskWithLines(60, 40, staffLines(8, 4, 6, 53));
    const structure = detectStaves(mask);
    expect(structure.staves).toHaveLength(1);
    expect(structure.unitSize).toBe(4);
    const [staff] = structure.staves;
    expect(staff.lines).toEqual([8, 12, 16, 20, 24]);
    expect(staff.unitSize).toBe(4);
    expect(staff.left).toBe(6);
    expect(staff.right).toBe(53);
  });

  it("splits two vertically separated staves", () => {
    const mask = maskWithLines(80, 120, [
      ...staffLines(10, 5, 5, 74),
      ...staffLines(80, 5, 5, 74),
    ]);
    const structure = detectStaves(mask);
    expect(structure.staves).toHaveLength(2);
    expect(structure.staves[0].lines[0]).toBe(10);
    expect(structure.staves[1].lines[0]).toBe(80);
    expect(structure.unitSize).toBe(5);
  });

  it("gives each staff its own extent", () => {
    const mask = maskWithLines(100, 120, [
      ...staffLines(10, 5, 5, 60),
      ...staffLines(80, 5, 20, 94),
    ]);
    const structure = detectStaves(mask);
    expect(structure.staves[0].left).toBe(5);
    expect(structure.staves[0].right).toBe(60);
    expect(structure.staves[1].left).toBe(20);
    expect(structure.staves[1].right).toBe(94);
  });

  it("drops a group that is not five lines", () => {
    // A complete staff plus three stray lines that cannot form a five-line set.
    const mask = maskWithLines(60, 80, [
      ...staffLines(8, 4, 6, 53),
      ...staffLines(60, 4, 6, 53, 3),
    ]);
    const structure = detectStaves(mask);
    expect(structure.staves).toHaveLength(1);
    expect(structure.staves[0].lines[0]).toBe(8);
  });

  it("returns an empty structure when there are too few lines", () => {
    const mask = maskWithLines(60, 40, staffLines(8, 4, 6, 53, 3));
    expect(detectStaves(mask)).toEqual({ staves: [], unitSize: 0 });
  });
});
