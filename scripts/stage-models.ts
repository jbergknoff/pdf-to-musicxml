/**
 * Stages the oemer model weights for deployment via Netlify Blobs.
 *
 * Netlify seeds a deploy's blob store from any files placed under
 * `.netlify/blobs/deploy/` during the build (the file name becomes the blob
 * key). We download each weight from oemer's GitHub release (MIT) into a local
 * cache and copy it there; the serving function then streams it back at
 * `/models/<file>` (netlify/functions/models.mts).
 *
 * Idempotent on two levels: the GitHub download is skipped when the cached file
 * already exists (the expensive step only happens once per machine/cache), and
 * Netlify de-duplicates the per-deploy upload by content digest, so an unchanged
 * (versioned) weight is only stored once across deploys.
 *
 * Used for deploys. Local dev instead serves public/models/ directly via
 * scripts/serve.ts, so this also leaves the cache copy under public/models/.
 */
import { cp, mkdir, stat } from "node:fs/promises";
import { MODEL_ENTRIES } from "../lib/models/manifest";

const CACHE_DIRECTORY = "public/models";
const DEPLOY_BLOBS_DIRECTORY = ".netlify/blobs/deploy";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(CACHE_DIRECTORY, { recursive: true });
await mkdir(DEPLOY_BLOBS_DIRECTORY, { recursive: true });

for (const entry of MODEL_ENTRIES) {
  const cachePath = `${CACHE_DIRECTORY}/${entry.fileName}`;
  if (await exists(cachePath)) {
    console.log(`✓ ${entry.fileName} already cached`);
  } else {
    console.log(`Downloading ${entry.fileName} from ${entry.sourceUrl}…`);
    const response = await fetch(entry.sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download ${entry.fileName}: ${response.status}`,
      );
    }
    await Bun.write(cachePath, response);
    console.log(`✓ ${entry.fileName}`);
  }

  // Seed the deploy blob store; the file name is the blob key.
  await cp(cachePath, `${DEPLOY_BLOBS_DIRECTORY}/${entry.fileName}`);
}

console.log(
  `Staged ${MODEL_ENTRIES.length} model(s) into ${DEPLOY_BLOBS_DIRECTORY}/`,
);
