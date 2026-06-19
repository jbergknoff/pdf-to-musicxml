/**
 * Headless low-vs-high-resolution validation for the segmentation pixel budget.
 *
 * The pixel budget in `lib/input/preprocess.ts` is the project's main
 * speed/accuracy knob: fewer pixels means fewer tiles and a faster WebGPU pass,
 * at the cost of recognition accuracy as notation shrinks below the model's
 * trained scale. This script answers "how far can we lower it before the results
 * stop matching?" by running the real `v2` pipeline (the same `lib/` code the
 * browser runs, via onnxruntime-node on CPU) over real pages at a high-resolution
 * reference and several lower candidate budgets, then reporting whether the
 * detected staff structure — and the segmentation masks — still agree.
 *
 * It is the resolution analogue of a gate: it exits non-zero if any candidate
 * detects a different number of staves than the reference, or moves the detected
 * stafflines by more than `--max-line-deviation` interline units. Mask IoUs are
 * reported for context. The served weights are never touched.
 *
 * Out of band (not part of the build / pr-ready). Needs the v2 weights in
 * public/models/ (`make models && make optimize-models`) and sample pages in
 * samples/ (gitignored, user-provided). Run via `make compare-resolutions`.
 *
 *   bun run scripts/compare-resolutions.ts \
 *     --reference 3000000 --candidates 2000000,1500000,1000000,750000 \
 *     --max-line-deviation 0.5
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { resize } from "../lib/input/preprocess";
import { MODEL_MANIFEST } from "../lib/models/manifest";
import {
  createSegmentationModels,
  segment,
  type SegmentationModels,
} from "../lib/segmentation/segment";
import { detectStaves } from "../lib/staves/detect-staves";
import type {
  Mask,
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../lib/types";
import { createNodeBackend } from "./node-backend";

const MODELS_DIRECTORY = "public/models";
const SAMPLES_DIRECTORY = "samples";

// The high-resolution reference (oemer's training floor — the best the models
// do) and the lower budgets to test against it. Overridable on the command line.
const DEFAULT_REFERENCE_PIXELS = 3_000_000;
const DEFAULT_CANDIDATE_PIXELS = [2_000_000, 1_500_000, 1_000_000, 750_000];

// A candidate "matches" the reference if it finds the same staves and its
// stafflines sit within this many interline units of the reference's (after
// normalizing for the resolution difference).
const DEFAULT_MAX_LINE_DEVIATION_UNITS = 0.5;

// The five masks segment() produces, named so the IoU report can label them.
const MASK_NAMES = [
  "staff",
  "symbols",
  "stemsRests",
  "noteheads",
  "clefsKeys",
] as const;

interface DecodedImage {
  data: Uint8Array;
  width: number;
  height: number;
}

function decodeImage(filePath: string): RgbaImage {
  const buffer = readFileSync(filePath);
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    const png = PNG.sync.read(buffer);
    return {
      data: new Uint8ClampedArray(png.data),
      width: png.width,
      height: png.height,
    };
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    const raw = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: true,
    }) as DecodedImage;
    return {
      data: new Uint8ClampedArray(raw.data),
      width: raw.width,
      height: raw.height,
    };
  }
  throw new Error(
    `Unsupported image type: ${filePath} (use .png / .jpg / .jpeg)`,
  );
}

function samplePaths(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(SAMPLES_DIRECTORY);
  } catch {
    entries = [];
  }
  const paths = entries
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .sort()
    .map((name) => join(SAMPLES_DIRECTORY, name));
  if (paths.length === 0) {
    throw new Error(
      `No sample pages in ${SAMPLES_DIRECTORY}/ — drop a few PNG/JPG scans of printed sheet music there first (gitignored, like public/models/).`,
    );
  }
  return paths;
}

async function loadModels(): Promise<SegmentationModels> {
  const backend = await createNodeBackend();
  const staffBytes = new Uint8Array(
    readFileSync(join(MODELS_DIRECTORY, MODEL_MANIFEST.staffSymbol.fileName)),
  );
  const symbolBytes = new Uint8Array(
    readFileSync(join(MODELS_DIRECTORY, MODEL_MANIFEST.symbolDetail.fileName)),
  );
  const staffSession = await backend.createSession(staffBytes);
  const symbolSession = await backend.createSession(symbolBytes);
  return createSegmentationModels(staffSession, symbolSession);
}

function resizeToBudget(image: RgbaImage, budget: number): RgbaImage {
  const pixels = image.width * image.height;
  const ratio = Math.sqrt(budget / pixels);
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  return resize(image, width, height);
}

interface PipelineResult {
  masks: SegmentationMasks;
  staves: StaffStructure;
  width: number;
  height: number;
}

async function runPipeline(
  image: RgbaImage,
  models: SegmentationModels,
  budget: number,
): Promise<PipelineResult> {
  const resized = resizeToBudget(image, budget);
  const masks = await segment(resized, models, {
    batchSize: MODEL_MANIFEST.staffSymbol.inputShape[0],
  });
  const staves = detectStaves(masks.staff);
  return { masks, staves, width: resized.width, height: resized.height };
}

interface StaffComparison {
  countMatch: boolean;
  maxLineDeviationPx: number;
  maxLineDeviationUnits: number;
  unitSizeRelativeError: number;
}

// Compare two staff structures across resolutions by normalizing positions to a
// fraction of page height (which is scale-invariant), then expressing the
// largest staffline disagreement back in reference pixels and interline units.
function compareStaves(
  reference: PipelineResult,
  candidate: PipelineResult,
): StaffComparison {
  const referenceStaves = reference.staves.staves;
  const candidateStaves = candidate.staves.staves;
  const countMatch = referenceStaves.length === candidateStaves.length;

  let maxDeviationFraction = 0;
  if (countMatch) {
    for (let index = 0; index < referenceStaves.length; index++) {
      const referenceStaff = referenceStaves[index];
      const candidateStaff = candidateStaves[index];
      const lineCount = Math.min(
        referenceStaff.lines.length,
        candidateStaff.lines.length,
      );
      for (let line = 0; line < lineCount; line++) {
        const deviation = Math.abs(
          referenceStaff.lines[line] / reference.height -
            candidateStaff.lines[line] / candidate.height,
        );
        if (deviation > maxDeviationFraction) {
          maxDeviationFraction = deviation;
        }
      }
    }
  }

  const maxLineDeviationPx = maxDeviationFraction * reference.height;
  const referenceUnit = reference.staves.unitSize;
  const referenceUnitFraction = referenceUnit / reference.height;
  const candidateUnitFraction = candidate.staves.unitSize / candidate.height;
  return {
    countMatch,
    maxLineDeviationPx,
    maxLineDeviationUnits:
      referenceUnit > 0 ? maxLineDeviationPx / referenceUnit : 0,
    unitSizeRelativeError:
      referenceUnitFraction > 0
        ? Math.abs(candidateUnitFraction - referenceUnitFraction) /
          referenceUnitFraction
        : 0,
  };
}

function resampleMaskNearest(
  mask: Mask,
  targetWidth: number,
  targetHeight: number,
): Mask {
  if (mask.width === targetWidth && mask.height === targetHeight) {
    return mask;
  }
  const data = new Uint8Array(targetWidth * targetHeight);
  const scaleX = mask.width / targetWidth;
  const scaleY = mask.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(Math.floor(y * scaleY), mask.height - 1);
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(Math.floor(x * scaleX), mask.width - 1);
      data[y * targetWidth + x] = mask.data[sourceY * mask.width + sourceX];
    }
  }
  return { data, width: targetWidth, height: targetHeight };
}

function maskIoU(a: Mask, b: Mask): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < a.data.length; index++) {
    const inA = a.data[index] !== 0;
    const inB = b.data[index] !== 0;
    if (inA || inB) {
      union++;
      if (inA && inB) {
        intersection++;
      }
    }
  }
  return union === 0 ? 1 : intersection / union;
}

function maskIoUs(
  reference: PipelineResult,
  candidate: PipelineResult,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of MASK_NAMES) {
    const referenceMask = reference.masks[name];
    const candidateMask = resampleMaskNearest(
      candidate.masks[name],
      referenceMask.width,
      referenceMask.height,
    );
    result[name] = maskIoU(referenceMask, candidateMask);
  }
  return result;
}

function megapixels(pixels: number): string {
  return `${(pixels / 1_000_000).toFixed(2)} MP`;
}

function parseBudgets(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined) {
    return fallback;
  }
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((pixels) => Number.isFinite(pixels) && pixels > 0);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      reference: { type: "string" },
      candidates: { type: "string" },
      "max-line-deviation": { type: "string" },
    },
  });
  const referenceBudget = values.reference
    ? Number.parseInt(values.reference, 10)
    : DEFAULT_REFERENCE_PIXELS;
  const candidateBudgets = parseBudgets(
    values.candidates,
    DEFAULT_CANDIDATE_PIXELS,
  );
  const maxLineDeviationUnits = values["max-line-deviation"]
    ? Number.parseFloat(values["max-line-deviation"])
    : DEFAULT_MAX_LINE_DEVIATION_UNITS;

  const models = await loadModels();
  const paths = samplePaths();
  console.info(
    `Comparing ${candidateBudgets.length} candidate budget(s) against a ` +
      `${megapixels(referenceBudget)} reference over ${paths.length} page(s).`,
  );
  console.info(
    `Pass: same staff count and stafflines within ${maxLineDeviationUnits} interline units of the reference.\n`,
  );

  let allPassed = true;
  for (const path of paths) {
    const image = decodeImage(path);
    const reference = await runPipeline(image, models, referenceBudget);
    console.info(
      `${path}  (decoded ${image.width}x${image.height})\n` +
        `  reference ${megapixels(referenceBudget)} -> ` +
        `${reference.width}x${reference.height}: ` +
        `${reference.staves.staves.length} staves, ` +
        `unit ${reference.staves.unitSize.toFixed(1)}px`,
    );

    for (const budget of candidateBudgets) {
      const candidate = await runPipeline(image, models, budget);
      const staves = compareStaves(reference, candidate);
      const ious = maskIoUs(reference, candidate);
      const passed =
        staves.countMatch &&
        staves.maxLineDeviationUnits <= maxLineDeviationUnits;
      allPassed = allPassed && passed;

      const iouText = MASK_NAMES.map(
        (name) => `${name} ${ious[name].toFixed(3)}`,
      ).join(", ");
      const stavesText = staves.countMatch
        ? `${candidate.staves.staves.length} staves [count ok], ` +
          `max line dev ${staves.maxLineDeviationPx.toFixed(1)}px ` +
          `(${staves.maxLineDeviationUnits.toFixed(2)} units), ` +
          `unit ${(staves.unitSizeRelativeError * 100).toFixed(1)}% off`
        : `${candidate.staves.staves.length} staves ` +
          `[COUNT MISMATCH vs ${reference.staves.staves.length}]`;
      console.info(
        `  ${megapixels(budget)} -> ${candidate.width}x${candidate.height}: ` +
          `${passed ? "PASS" : "FAIL"} — ${stavesText}\n` +
          `      mask IoU: ${iouText}`,
      );
    }
    console.info("");
  }

  if (!allPassed) {
    console.info("FAIL: a candidate budget did not match the reference.");
    return 1;
  }
  console.info("PASS: all candidate budgets matched the reference.");
  return 0;
}

process.exit(await main());
