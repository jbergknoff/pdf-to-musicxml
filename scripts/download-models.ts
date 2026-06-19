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
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;

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
 *
 * Uses the End of Central Directory record to locate the central directory,
 * which always contains the correct compressed/uncompressed sizes even when
 * the ZIP was written with a data descriptor (general-purpose flag bit 3 set,
 * meaning sizes in the local file header are zero).
 */
async function extractFirstFileFromZip(
  zipData: ArrayBuffer,
): Promise<Uint8Array> {
  const view = new DataView(zipData);
  const totalSize = zipData.byteLength;

  if (view.getUint32(0, true) !== ZIP_LOCAL_HEADER_SIG) {
    throw new Error(
      "Not a valid ZIP file (missing local file header signature)",
    );
  }

  // Scan backwards for the EOCD signature. The comment field at the end can
  // be up to 65535 bytes, but in practice is absent here.
  let eocdOffset = -1;
  const searchStart = Math.max(0, totalSize - EOCD_SIZE - 65535);
  for (let offset = totalSize - EOCD_SIZE; offset >= searchStart; offset--) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIG) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("ZIP: End of Central Directory record not found");
  }

  // EOCD layout (all little-endian):
  //   +0  signature (4)
  //   +4  disk number (2)
  //   +6  disk with CD start (2)
  //   +8  entries on this disk (2)
  //   +10 total entries (2)
  //   +12 CD size (4)
  //   +16 CD offset (4)
  //   +20 comment length (2)
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  if (view.getUint32(centralDirOffset, true) !== ZIP_CENTRAL_DIR_SIG) {
    throw new Error("ZIP: Central directory entry signature not found");
  }

  // Central directory entry layout (all little-endian):
  //   +0  signature (4)
  //   +4  version made by (2)
  //   +6  version needed (2)
  //   +8  general purpose flag (2)
  //   +10 compression method (2)
  //   +12 last mod file time (2)
  //   +14 last mod file date (2)
  //   +16 crc-32 (4)
  //   +20 compressed size (4)
  //   +24 uncompressed size (4)
  //   +28 file name length (2)
  //   +30 extra field length (2)
  //   +32 file comment length (2)
  //   +34 disk number start (2)
  //   +36 internal attributes (2)
  //   +38 external attributes (4)
  //   +42 relative offset of local header (4)
  const compressionMethod = view.getUint16(centralDirOffset + 10, true);
  const compressedSize = view.getUint32(centralDirOffset + 20, true);
  const uncompressedSize = view.getUint32(centralDirOffset + 24, true);
  const localHeaderOffset = view.getUint32(centralDirOffset + 42, true);

  // Use the local file header only to find the data start offset.
  // Local header layout:
  //   +0  signature (4)
  //   +26 file name length (2)
  //   +28 extra field length (2)
  const localFnLen = view.getUint16(localHeaderOffset + 26, true);
  const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + localFnLen + localExtraLen;

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
