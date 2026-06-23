/**
 * Fetch a single model weight from its **upstream source** (the original oemer /
 * homr GitHub releases named in the manifest), extracting the ONNX file from a
 * ZIP archive when the entry is zipped. This is the source `make models` uses to
 * populate `public/models/`, and it doubles as the OMR integration tests' offline
 * fallback when the served (Netlify) weights host is unreachable
 * (`tests/integration/helpers/omr-pipeline.ts`).
 *
 * Equivalence to the served weights: the TrOMR encoder/decoder are served exactly
 * as released here (the manifest notes they are served as-is), so they are
 * byte-identical. The oemer segmentation models are served after
 * `scripts/optimize-models.py` (onnxsim, asserted numerically identical), so they
 * predict the same; and the default *classical* staff-detection path the fixtures
 * use does not run them at all. So weights fetched from here recover the same
 * MusicXML as the served v2 weights.
 *
 * This module has **no top-level side effects** (no download on import) so both
 * the `download-models.ts` script and the test helper can import it.
 */
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import type { ModelManifestEntry } from "../lib/models/manifest";

const inflateRawAsync = promisify(inflateRaw);

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;

/**
 * Extract the first (and only) ONNX file from a ZIP archive.
 * Supports stored (method 0) and DEFLATE (method 8) compression.
 *
 * Uses the End of Central Directory record to locate the central directory,
 * which always contains the correct compressed/uncompressed sizes even when
 * the ZIP was written with a data descriptor (general-purpose flag bit 3 set,
 * meaning sizes in the local file header are zero).
 */
export async function extractFirstFileFromZip(
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

/**
 * Download one model's ONNX bytes from its upstream `sourceUrl`, extracting the
 * archive when the entry is zipped. Throws on a non-OK response.
 */
export async function fetchModelFromSource(
  entry: ModelManifestEntry,
): Promise<Uint8Array> {
  const response = await fetch(entry.sourceUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${entry.fileName}: ${response.status} from ${entry.sourceUrl}`,
    );
  }
  const rawData = await response.arrayBuffer();
  if (entry.sourceIsZip === true) {
    return extractFirstFileFromZip(rawData);
  }
  return new Uint8Array(rawData);
}
