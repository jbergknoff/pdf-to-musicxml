/**
 * Downloads the model weights into public/models/ for local development,
 * under their versioned manifest file names so scripts/serve.ts can serve
 * them at the same `/models/<file>` URLs the deployed app uses (where a
 * Netlify function streams them from Blobs instead). The weights are
 * gitignored; run once via `make models`.
 *
 * Sources:
 *   oemer segmentation models — GitHub release `checkpoints` tag (MIT).
 *   TrOMR encoder/decoder    — homr onnx_checkpoints release (Apache-2.0
 *                              weights, AGPL-3.0 project). Downloaded as
 *                              ZIP archives; the ONNX file is extracted here.
 */
import { mkdir, stat } from "node:fs/promises";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { MODEL_ENTRIES } from "../lib/models/manifest";

const inflateRawAsync = promisify(inflateRaw);
const TARGET_DIRECTORY = "public/models";
const ZIP_LOCAL_HEADER_SIG = 0x04034b50;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the first (and only) ONNX file from a ZIP archive.
 * Supports stored (method 0) and DEFLATE (method 8) compression.
 */
async function extractFirstFileFromZip(
  zipData: ArrayBuffer,
): Promise<Uint8Array> {
  const view = new DataView(zipData);

  if (view.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIG) {
    throw new Error(
      "Not a valid ZIP file (missing local file header signature)",
    );
  }

  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const uncompressedSize = view.getUint32(22, true);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);

  if (compressedSize === 0 && compressionMethod !== 0) {
    throw new Error(
      "ZIP uses a data descriptor (compressed size = 0 in local header) " +
        "— cannot determine compressed size. Re-pack the ZIP with sizes in the local header.",
    );
  }

  const dataOffset = 30 + fileNameLength + extraFieldLength;

  if (compressionMethod === 0) {
    // Stored (no compression): copy the bytes.
    return new Uint8Array(
      zipData.slice(dataOffset, dataOffset + uncompressedSize),
    );
  }

  if (compressionMethod === 8) {
    // DEFLATE: decompress with node:zlib inflateRaw (raw deflate, no zlib header).
    const compressed = Buffer.from(
      new Uint8Array(zipData, dataOffset, compressedSize),
    );
    const decompressed = await inflateRawAsync(compressed);
    return new Uint8Array(
      decompressed.buffer,
      decompressed.byteOffset,
      decompressed.byteLength,
    );
  }

  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

await mkdir(TARGET_DIRECTORY, { recursive: true });

for (const entry of MODEL_ENTRIES) {
  const target = `${TARGET_DIRECTORY}/${entry.fileName}`;
  if (await exists(target)) {
    console.log(`✓ ${entry.fileName} already present`);
    continue;
  }
  console.log(`Downloading ${entry.fileName}…`);
  const response = await fetch(entry.sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${entry.fileName}: ${response.status} from ${entry.sourceUrl}`,
    );
  }
  // Buffer then write: passing the Response straight to Bun.write streams
  // pathologically slowly (minutes for ~70 MB); arrayBuffer + write is ~1 s.
  const rawData = await response.arrayBuffer();

  if (entry.sourceIsZip === true) {
    console.log(
      `  Extracting ONNX from ZIP (${Math.round(rawData.byteLength / 1024 / 1024)} MB)…`,
    );
    const onnxBytes = await extractFirstFileFromZip(rawData);
    await Bun.write(target, onnxBytes);
  } else {
    await Bun.write(target, rawData);
  }
  console.log(`✓ ${entry.fileName}`);
}

console.log(`Models ready in ${TARGET_DIRECTORY}/`);
