import { describe, expect, it } from "bun:test";
import type { Mask, RgbaImage } from "../types";
import { compositeMasks, fadeToWhite } from "./overlay";

function solidWhite(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { data, width, height };
}

function solidColor(
  color: [number, number, number, number],
  width: number,
  height: number,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set(color, offset);
  }
  return { data, width, height };
}

function maskFrom(values: number[], width: number, height: number): Mask {
  return { data: Uint8Array.from(values), width, height };
}

describe("compositeMasks", () => {
  it("blends color over masked pixels and leaves others unchanged", () => {
    const base = solidWhite(2, 1);
    const mask = maskFrom([1, 0], 2, 1);
    const result = compositeMasks(base, [{ mask, color: [255, 0, 0] }], 0.5);
    // Masked pixel: 255*0.5 + color*0.5 -> (255, 127.5->128, 128).
    expect(result.data[0]).toBe(255);
    expect(result.data[1]).toBe(128);
    expect(result.data[2]).toBe(128);
    // Unmasked pixel stays white.
    expect(Array.from(result.data.slice(4, 7))).toEqual([255, 255, 255]);
  });

  it("does not mutate the base image", () => {
    const base = solidWhite(1, 1);
    const before = Array.from(base.data);
    compositeMasks(base, [{ mask: maskFrom([1], 1, 1), color: [0, 0, 0] }]);
    expect(Array.from(base.data)).toEqual(before);
  });

  it("rejects a mask whose size differs from the image", () => {
    const base = solidWhite(2, 2);
    const mask = maskFrom([1], 1, 1);
    expect(() => compositeMasks(base, [{ mask, color: [0, 0, 0] }])).toThrow();
  });
});

describe("fadeToWhite", () => {
  it("washes color halfway toward white and preserves alpha", () => {
    const base = solidColor([0, 100, 200, 255], 1, 1);
    const result = fadeToWhite(base, 0.5);
    // Each channel: value*0.5 + 255*0.5.
    expect(Array.from(result.data)).toEqual([128, 178, 228, 255]);
  });

  it("leaves the image unchanged at amount 0", () => {
    const base = solidColor([10, 20, 30, 255], 1, 1);
    const result = fadeToWhite(base, 0);
    expect(Array.from(result.data)).toEqual([10, 20, 30, 255]);
  });

  it("does not mutate the base image", () => {
    const base = solidColor([10, 20, 30, 255], 1, 1);
    const before = Array.from(base.data);
    fadeToWhite(base, 0.8);
    expect(Array.from(base.data)).toEqual(before);
  });
});
