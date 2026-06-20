/**
 * First half of `make upload-models`: download the model weights to disk and
 * write an upload plan for the Netlify CLI step.
 *
 * The weights (~109 MB) are pushed to Netlify Blobs **once, out of band** — not
 * during the deploy, where the upload was timing out. This Bun script runs in
 * the main container (download + manifest access); a Node step then reads the
 * plan and runs `netlify blobs:set` per blob (scripts/blob-upload.mjs), since
 * the Netlify CLI needs Node.
 *
 * Source: oemer's GitHub release `checkpoints` tag (MIT-licensed).
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { MODEL_ENTRIES, MODEL_STORE_NAME } from "../lib/models/manifest";

const DIRECTORY = "public/models";
const PLAN_PATH = `${DIRECTORY}/upload-plan.json`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(DIRECTORY, { recursive: true });

const blobs: { key: string; file: string }[] = [];
for (const entry of MODEL_ENTRIES) {
  const file = `${DIRECTORY}/${entry.fileName}`;
  if (await exists(file)) {
    console.log(`✓ ${entry.fileName} already on disk`);
  } else {
    console.log(`Downloading ${entry.fileName} from ${entry.sourceUrl}…`);
    const response = await fetch(entry.sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download ${entry.fileName}: ${response.status}`,
      );
    }
    // Buffer then write: passing the Response straight to Bun.write streams
    // pathologically slowly (minutes for ~70 MB); arrayBuffer + write is ~1 s.
    await Bun.write(file, await response.arrayBuffer());
    console.log(`✓ ${entry.fileName}`);
  }
  // The blob key is the (versioned) file name, matching the serving function.
  blobs.push({ key: entry.fileName, file });
}

await writeFile(
  PLAN_PATH,
  `${JSON.stringify({ store: MODEL_STORE_NAME, blobs }, null, 2)}\n`,
);
console.log(`Wrote upload plan -> ${PLAN_PATH}`);
