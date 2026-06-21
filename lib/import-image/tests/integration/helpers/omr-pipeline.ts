/**
 * Headless OMR pipeline for the integration tests.
 *
 * Runs the *actual* recognition pipeline (the same runtime-agnostic `lib/` code
 * the browser worker drives) end-to-end in Node via onnxruntime-node on the CPU:
 * decode an image → segment → detect staves → detect braces → transcribe each
 * staff with TrOMR → group systems → assemble MusicXML. No browser, no WebGPU,
 * no WASM — so the result is deterministic run-to-run (single-threaded CPU,
 * greedy argmax decoding) and never depends on a GPU being present in CI.
 *
 * This mirrors `src/worker/omr.worker.ts`'s `process()` (and the single-page
 * case of the public `importFile` in `index.ts`); keep the two in sync.
 *
 * The model weights are the same ones the app serves from Netlify Blobs. They
 * are fetched once (see {@link ensureModels}) and cached on disk, so the slow
 * download happens at most once per machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-node";
import { PNG } from "pngjs";
import { buildScore } from "../../../lib/assembly/musicxml-builder";
import { resizeToPixelBudget } from "../../../lib/input/preprocess";
import {
  MODEL_ENTRIES,
  MODEL_MANIFEST,
  type ModelManifestEntry,
  modelUrl,
} from "../../../lib/models/manifest";
import type {
  InferenceBackend,
  InferenceSession,
  Tensor,
  TensorDataType,
} from "../../../lib/runtime/inference-backend";
import {
  createSegmentationModels,
  segment,
  type SegmentationModels,
} from "../../../lib/segmentation/segment";
import { detectBraces } from "../../../lib/staves/brace-detection";
import { detectStaves } from "../../../lib/staves/detect-staves";
import { groupSystems } from "../../../lib/staves/system-grouping";
import { transcribeStaves } from "../../../lib/transcription/transcribe";
import type { TrOMRSessions } from "../../../lib/transcription/tromr-session";
import type {
  RgbaImage,
  ScoreSystem,
  Staff,
  Transcription,
} from "../../../lib/types";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the weights are cached on disk. Defaults to the same `public/models/`
 * directory `make models` and the local static server use, so a developer who
 * has already populated it pays no download; override with `OMR_MODELS_DIR`.
 */
export const MODELS_DIRECTORY =
  process.env.OMR_MODELS_DIR ?? join(here, "../../../public/models");

/**
 * Base URL the weights are fetched from when not present on disk. Defaults to
 * the deployed app's Netlify host (the function streams the v2 weights from
 * Blobs at `/models/<file>`), so CI downloads the exact weights the app ships.
 */
export const MODELS_BASE_URL =
  process.env.OMR_MODELS_BASE_URL ?? "https://musicxml-editor.netlify.app";

// ---------------------------------------------------------------------------
// Inference backend (onnxruntime-node, CPU, deterministic)
// ---------------------------------------------------------------------------

function toOrtTensor(tensor: Tensor): ort.Tensor {
  if (tensor.type === "uint8") {
    return new ort.Tensor("uint8", tensor.data as Uint8Array, tensor.dims);
  }
  if (tensor.type === "int64") {
    return new ort.Tensor("int64", tensor.data as BigInt64Array, tensor.dims);
  }
  return new ort.Tensor("float32", tensor.data as Float32Array, tensor.dims);
}

function fromOrtTensor(value: ort.Tensor): Tensor {
  return {
    type: value.type as TensorDataType,
    data: value.data as Float32Array | Uint8Array | BigInt64Array,
    dims: value.dims as number[],
  };
}

/**
 * A CPU-only onnxruntime-node backend, pinned to a single intra-/inter-op
 * thread. Single-threaded execution removes the run-to-run nondeterminism that
 * parallel floating-point reductions introduce, so the recovered MusicXML is
 * stable — the integration tests assert on it exactly.
 */
export function createDeterministicNodeBackend(): InferenceBackend {
  return {
    provider: "cpu",
    async createSession(modelBytes): Promise<InferenceSession> {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
      });
      return {
        inputNames: session.inputNames,
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            ortFeeds[name] = toOrtTensor(tensor);
          }
          const results = await session.run(ortFeeds);
          const output: Record<string, Tensor> = {};
          for (const [name, value] of Object.entries(results)) {
            output[name] = fromOrtTensor(value);
          }
          return output;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Model weights (fetch once, cache on disk)
// ---------------------------------------------------------------------------

async function fetchModelToDisk(
  entry: ModelManifestEntry,
  target: string,
): Promise<void> {
  const url = `${MODELS_BASE_URL}${modelUrl(entry)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch model "${entry.fileName}" from ${url}: ${response.status}`,
    );
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

/**
 * Ensure every model weight file exists in {@link MODELS_DIRECTORY}, downloading
 * any that are missing from {@link MODELS_BASE_URL}. Returns the directory.
 * Idempotent: present files are left untouched, so this is the once-per-machine
 * download the tests rely on.
 */
export async function ensureModels(): Promise<string> {
  mkdirSync(MODELS_DIRECTORY, { recursive: true });
  for (const entry of MODEL_ENTRIES) {
    const target = join(MODELS_DIRECTORY, entry.fileName);
    if (!existsSync(target)) {
      await fetchModelToDisk(entry, target);
    }
  }
  return MODELS_DIRECTORY;
}

/** The loaded inference sessions the pipeline runs on, created once and reused. */
export interface OmrModels {
  segmentation: SegmentationModels;
  tromr: TrOMRSessions;
}

function readModelBytes(entry: ModelManifestEntry): Uint8Array {
  return new Uint8Array(readFileSync(join(MODELS_DIRECTORY, entry.fileName)));
}

/**
 * Load all four weights (after {@link ensureModels}) and build their inference
 * sessions on the deterministic CPU backend. Loading is the expensive part, so
 * tests do it once and pass the result to {@link recognizeImage} per fixture.
 */
export async function loadOmrModels(): Promise<OmrModels> {
  const backend = createDeterministicNodeBackend();
  const staffSymbol = await backend.createSession(
    readModelBytes(MODEL_MANIFEST.staffSymbol),
  );
  const symbolDetail = await backend.createSession(
    readModelBytes(MODEL_MANIFEST.symbolDetail),
  );
  const encoder = await backend.createSession(
    readModelBytes(MODEL_MANIFEST.tromrEncoder),
  );
  const decoder = await backend.createSession(
    readModelBytes(MODEL_MANIFEST.tromrDecoder),
  );
  return {
    segmentation: createSegmentationModels(staffSymbol, symbolDetail),
    tromr: { encoder, decoder },
  };
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

/** Decode a PNG/JPEG file into the pipeline's RGBA raster. */
export function decodeImageFile(filePath: string): RgbaImage {
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
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return {
      data: new Uint8ClampedArray(raw.data),
      width: raw.width,
      height: raw.height,
    };
  }
  throw new Error(`Unsupported image type: ${filePath} (use .png / .jpg)`);
}

// ---------------------------------------------------------------------------
// Pipeline (mirrors src/worker/omr.worker.ts process())
// ---------------------------------------------------------------------------

// The served weights bake a fixed batch into the graph (one tile per inference);
// see the worker. Both segmentation models are frozen at batch 1.
const FIXED_BATCH_SIZE = MODEL_MANIFEST.staffSymbol.inputShape[0];

/** Scale a staff from segmentation-image space into full-resolution space. */
function scaleStaff(staff: Staff, scaleX: number, scaleY: number): Staff {
  return {
    lines: staff.lines.map((line) => line * scaleY),
    unitSize: staff.unitSize * scaleY,
    left: Math.round(staff.left * scaleX),
    right: Math.round(staff.right * scaleX),
  };
}

export interface RecognitionResult {
  /** The recovered MusicXML, or "" when nothing was recognized. */
  musicXml: string;
  /** Number of staves detected (segmentation-image space). */
  staffCount: number;
  /** Total note events across all staves. */
  noteCount: number;
}

/**
 * Recognize one already-decoded page. Runs the same phases as the worker:
 * segment (downscaled) → detect staves → detect braces → transcribe (full-res
 * crops) → group systems → build score. Returns "" for MusicXML when no notes
 * were recognized, matching the worker/importer empty-result contract.
 */
export async function recognizeImage(
  image: RgbaImage,
  models: OmrModels,
): Promise<RecognitionResult> {
  const segImage = resizeToPixelBudget(image);
  const masks = await segment(segImage, models.segmentation, {
    batchSize: FIXED_BATCH_SIZE,
  });
  const staves = detectStaves(masks.staff);
  const braces = detectBraces(segImage, staves.staves);

  if (staves.staves.length === 0) {
    return { musicXml: "", staffCount: 0, noteCount: 0 };
  }

  const scaleX = image.width / segImage.width;
  const scaleY = image.height / segImage.height;
  const fullResStaves = staves.staves.map((staff) =>
    scaleStaff(staff, scaleX, scaleY),
  );

  const transcriptions: Transcription[] = await transcribeStaves(
    models.tromr,
    image,
    fullResStaves,
  );
  let noteCount = 0;
  for (const transcription of transcriptions) {
    noteCount += transcription.notes.length;
  }

  const systems: ScoreSystem[] = groupSystems(transcriptions, braces);
  const musicXml = noteCount === 0 ? "" : buildScore(systems);
  return { musicXml, staffCount: staves.staves.length, noteCount };
}
