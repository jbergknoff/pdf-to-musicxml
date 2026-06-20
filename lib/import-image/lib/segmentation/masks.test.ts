import { describe, expect, it } from "bun:test";
import type { ProbabilityMap } from "../types";
import { argmaxClassMap, classMask } from "./masks";

describe("argmaxClassMap", () => {
  it("selects the highest-probability channel per pixel", () => {
    // Two pixels, three classes. Pixel 0 favors class 2; pixel 1 favors class 0.
    const probabilities: ProbabilityMap = {
      data: new Float32Array([0.1, 0.2, 0.7, 0.6, 0.3, 0.1]),
      width: 2,
      height: 1,
      channels: 3,
    };
    expect(Array.from(argmaxClassMap(probabilities))).toEqual([2, 0]);
  });

  it("keeps the first channel on ties", () => {
    const probabilities: ProbabilityMap = {
      data: new Float32Array([0.5, 0.5]),
      width: 1,
      height: 1,
      channels: 2,
    };
    expect(Array.from(argmaxClassMap(probabilities))).toEqual([0]);
  });
});

describe("classMask", () => {
  it("marks only the pixels assigned to the requested class", () => {
    const classMap = new Uint8Array([0, 1, 2, 1]);
    const mask = classMask(classMap, 2, 2, 1);
    expect(Array.from(mask.data)).toEqual([0, 1, 0, 1]);
    expect(mask.width).toBe(2);
    expect(mask.height).toBe(2);
  });
});
