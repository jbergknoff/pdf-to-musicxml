/**
 * Downloads the model weights into public/models/ for local development,
 * under their versioned manifest file names so scripts/serve.ts can serve
 * them at the same `/models/<file>` URLs the deployed app uses (where a
 * Netlify function streams them from Blobs instead). The weights are
 * gitignored; run once via `make models`.
 *
 * Sources (see scripts/model-source.ts for the fetch + ZIP-extraction logic):
 *   oemer segmentation models — GitHub release `checkpoints` tag (MIT).
 *   TrOMR encoder/decoder    — homr onnx_checkpoints release (Apache-2.0
 *                              weights, AGPL-3.0 project). Downloaded as
 *                              ZIP archives; the ONNX file is extracted here.
 *
 * Run after this (out of band) `make optimize-models` to fold the segmentation
 * weights into their served v2 form; the TrOMR weights are served as-is. The OMR
 * integration tests, however, can use what this writes directly (see the helper
 * `ensureModels` in tests/integration/helpers/omr-pipeline.ts) — they use the
 * model-free classical staff path, so the unoptimized segmentation weights here
 * are never run.
 */
import { mkdir, stat } from "node:fs/promises";
import { MODEL_ENTRIES } from "../lib/models/manifest";
import { fetchModelFromSource } from "./model-source";

const TARGET_DIRECTORY = "public/models";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(TARGET_DIRECTORY, { recursive: true });

for (const entry of MODEL_ENTRIES) {
  const target = `${TARGET_DIRECTORY}/${entry.fileName}`;
  if (await exists(target)) {
    console.log(`✓ ${entry.fileName} already present`);
    continue;
  }
  console.log(`Downloading ${entry.fileName}…`);
  const onnxBytes = await fetchModelFromSource(entry);
  await Bun.write(target, onnxBytes);
  console.log(`✓ ${entry.fileName}`);
}

console.log(`Models ready in ${TARGET_DIRECTORY}/`);
