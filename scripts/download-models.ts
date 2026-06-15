/**
 * Downloads the oemer model weights into public/models/ for local development,
 * under their versioned manifest file names so scripts/serve.ts can serve them
 * at the same `/models/<file>` URLs the deployed app uses (where a Netlify
 * function streams them from Blobs instead). The weights are gitignored and
 * total ~109 MB; run once via `make models`.
 *
 * Source: oemer's GitHub release `checkpoints` tag (MIT-licensed).
 */
import { mkdir, stat } from "node:fs/promises";
import { MODEL_ENTRIES } from "../lib/models/manifest";

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
  const response = await fetch(entry.sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${entry.fileName}: ${response.status}`);
  }
  await Bun.write(target, response);
  console.log(`✓ ${entry.fileName}`);
}

console.log(`Models ready in ${TARGET_DIRECTORY}/`);
