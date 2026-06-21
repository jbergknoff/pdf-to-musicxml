import { describe, expect, it } from "bun:test";
import type { RgbaImage } from "../types";
import { resize, resizeToPixelBudget } from "./preprocess";

function gradientImage(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = pixel % 256;
    data[pixel * 4 + 1] = 100;
    data[pixel * 4 + 2] = 200;
    data[pixel * 4 + 3] = 255;
  }
  return { data, width, height };
}

describe("resizeToPixelBudget", () => {
  it("leaves a 1 M px image untouched", () => {
    const image = gradientImage(1000, 1000); // exactly 1 M px
    expect(resizeToPixelBudget(image)).toBe(image);
  });

  it("downscales an oversized image to ~1 M px", () => {
    const image = gradientImage(4000, 3000); // 12 M px
    const resized = resizeToPixelBudget(image);
    const pixels = resized.width * resized.height;
    expect(pixels).toBeGreaterThan(950_000);
    expect(pixels).toBeLessThan(1_050_000);
    // Aspect ratio is preserved within rounding.
    expect(resized.width / resized.height).toBeCloseTo(4000 / 3000, 2);
  });

  it("upscales a tiny image to ~1 M px", () => {
    const image = gradientImage(400, 300); // 0.12 M px
    const resized = resizeToPixelBudget(image);
    const pixels = resized.width * resized.height;
    expect(pixels).toBeGreaterThan(950_000);
    expect(pixels).toBeLessThan(1_050_000);
  });

  it("scales to an explicit (higher) budget when given one", () => {
    const image = gradientImage(2000, 1500); // 3 M px
    const resized = resizeToPixelBudget(image, 3_000_000);
    // Already at the 3 M px budget: returned untouched.
    expect(resized).toBe(image);
    // A 12 M px page is downscaled toward the 3 M px budget, not 1 M px.
    const downscaled = resizeToPixelBudget(gradientImage(4000, 3000), 3_000_000);
    const pixels = downscaled.width * downscaled.height;
    expect(pixels).toBeGreaterThan(2_850_000);
    expect(pixels).toBeLessThan(3_150_000);
  });
});

describe("resize", () => {
  it("returns the same image when dimensions are unchanged", () => {
    const image = gradientImage(3, 3);
    expect(resize(image, 3, 3)).toBe(image);
  });

  it("preserves corner pixels under bilinear sampling", () => {
    // Bilinear maps output corners exactly onto source corners, so corner
    // colors survive a resize regardless of scale.
    const image = gradientImage(4, 4);
    const resized = resize(image, 8, 8);
    expect(resized.width).toBe(8);
    expect(resized.height).toBe(8);
    // Top-left corner.
    expect(resized.data[0]).toBe(image.data[0]);
    // Bottom-right corner.
    const sourceCorner = (4 * 4 - 1) * 4;
    const targetCorner = (8 * 8 - 1) * 4;
    expect(resized.data[targetCorner]).toBe(image.data[sourceCorner]);
  });
});
