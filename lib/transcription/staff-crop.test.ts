import { describe, expect, it } from "bun:test";
import type { RgbaImage, Staff } from "../types";
import {
  cropStaff,
  prepareStaffTensor,
  TROMR_INPUT_HEIGHT,
  TROMR_INPUT_WIDTH,
  TROMR_NORM_MEAN,
  TROMR_NORM_STD,
  TROMR_NORM_WHITE,
} from "./staff-crop";

function solidImage(
  width: number,
  height: number,
  r = 200,
  g = 200,
  b = 200,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = r;
    data[index * 4 + 1] = g;
    data[index * 4 + 2] = b;
    data[index * 4 + 3] = 255;
  }
  return { data, width, height };
}

function makeStaff(
  lines: number[],
  unitSize: number,
  left: number,
  right: number,
): Staff {
  return { lines, unitSize, left, right };
}

describe("cropStaff", () => {
  it("extracts the correct rectangular region", () => {
    const image = solidImage(100, 200);
    const staff = makeStaff([40, 45, 50, 55, 60], 5, 10, 90);
    const cropped = cropStaff(image, staff);

    // Width: 90 - 10 + 1 = 81; height: padded around lines[0]=40 and lines[4]=60
    expect(cropped.width).toBe(81);
    // Padding = round(5 * 2.5) = 13; top = 40 - 13 = 27, bottom = 60 + 13 = 73
    expect(cropped.height).toBe(73 - 27 + 1);
  });

  it("clamps crop to image bounds", () => {
    const image = solidImage(80, 80);
    // Staff near the top edge — top padding would go negative.
    const staff = makeStaff([2, 7, 12, 17, 22], 5, 0, 79);
    const cropped = cropStaff(image, staff);
    expect(cropped.width).toBe(80);
    // top = max(0, 2 - 13) = 0; bottom = min(79, 22 + 13) = 35
    expect(cropped.height).toBe(36);
  });

  it("preserves pixel values from the source image", () => {
    const image = solidImage(50, 50, 128, 64, 32);
    const staff = makeStaff([20, 22, 24, 26, 28], 2, 5, 44);
    const cropped = cropStaff(image, staff);
    // All pixels in the crop should be 128, 64, 32, 255.
    expect(cropped.data[0]).toBe(128);
    expect(cropped.data[1]).toBe(64);
    expect(cropped.data[2]).toBe(32);
    expect(cropped.data[3]).toBe(255);
  });
});

describe("prepareStaffTensor", () => {
  it("outputs a fixed [targetHeight × targetWidth] tensor", () => {
    const image = solidImage(256, 64);
    const { data, width } = prepareStaffTensor(
      image,
      TROMR_INPUT_HEIGHT,
      TROMR_INPUT_WIDTH,
    );
    expect(width).toBe(TROMR_INPUT_WIDTH);
    expect(data.length).toBe(TROMR_INPUT_HEIGHT * TROMR_INPUT_WIDTH);
  });

  it("keeps normalized values within the mean/std range", () => {
    // A gray image plus white padding: every value lies between the normalized
    // black (-mean/std) and white ((1 - mean)/std) bounds.
    const image = solidImage(32, 32, 128, 128, 128);
    const blackBound = -TROMR_NORM_MEAN / TROMR_NORM_STD;
    const { data } = prepareStaffTensor(image, 32);
    for (const value of data) {
      expect(value).toBeGreaterThanOrEqual(blackBound);
      expect(value).toBeLessThanOrEqual(TROMR_NORM_WHITE);
    }
  });

  it("produces the normalized white value for a fully white image", () => {
    const image = solidImage(16, 16, 255, 255, 255);
    const { data } = prepareStaffTensor(image, 16, 16);
    for (const value of data) {
      expect(value).toBeCloseTo(TROMR_NORM_WHITE, 5);
    }
  });

  it("produces the normalized black value for a fully black image", () => {
    const image = solidImage(16, 16, 0, 0, 0);
    // Pass matching targetWidth so there is no white padding.
    const blackValue = (0 - TROMR_NORM_MEAN) / TROMR_NORM_STD;
    const { data } = prepareStaffTensor(image, 16, 16);
    for (const value of data) {
      expect(value).toBeCloseTo(blackValue, 5);
    }
  });

  it("vertically centers the staff, leaving white margins above and below", () => {
    // A short image (16 tall) on a 64-tall canvas: the content occupies the
    // middle band, with normalized-white padding rows top and bottom.
    const image = solidImage(16, 16, 0, 0, 0);
    const { data } = prepareStaffTensor(image, 64, 16);
    // Top row is padding (white); a middle row holds black content.
    expect(data[0]).toBeCloseTo(TROMR_NORM_WHITE, 5);
    const blackValue = (0 - TROMR_NORM_MEAN) / TROMR_NORM_STD;
    expect(data[32 * 16]).toBeCloseTo(blackValue, 5);
  });
});
