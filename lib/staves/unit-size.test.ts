import { describe, expect, it } from "bun:test";
import { estimateUnitSize, median } from "./unit-size";

describe("median", () => {
  it("returns the middle of an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the middle pair of an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("estimateUnitSize", () => {
  it("returns the gap of an evenly spaced single staff", () => {
    expect(estimateUnitSize([10, 14, 18, 22, 26])).toBe(4);
  });

  it("ignores the large between-staff gap", () => {
    // Two staves spaced 4 apart, separated by a gap of 40. The lone large gap
    // is outvoted by the eight within-staff gaps.
    const centers = [10, 14, 18, 22, 26, 66, 70, 74, 78, 82];
    expect(estimateUnitSize(centers)).toBe(4);
  });

  it("sorts before measuring gaps", () => {
    expect(estimateUnitSize([26, 10, 22, 14, 18])).toBe(4);
  });

  it("returns zero with fewer than two values", () => {
    expect(estimateUnitSize([7])).toBe(0);
    expect(estimateUnitSize([])).toBe(0);
  });
});
