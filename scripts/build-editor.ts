/**
 * Builds the editor SPA into editor/dist/.
 *
 * The editor is the deploy target. Its "import from image/PDF" feature reuses
 * the OMR pipeline under lib/import-image/, so this build bundles two entries —
 * the editor app and the OMR worker — and stages the runtime assets those fetch
 * (not inline) at run time:
 *   - ORT Web's `.wasm` / threaded `.mjs` under dist/ort/ (ORT points at /ort/).
 *   - pdf.js's worker bundle at the site root (decode.ts points at it).
 *   - anything under lib/import-image/public/ copied as-is (model weights are
 *     excluded — they are served same-origin by the models function, or by the
 *     local dev server from lib/import-image/public/models/).
 *
 * The worker is a separate entry point so it bundles into its own
 * editor/dist/omr.worker.js, loaded by omr-client.ts via
 * `new Worker("/omr.worker.js")`. index.html and the assets all resolve from the
 * publish root (editor/dist), so the deployed site root is editor/dist.
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";

const OUT_DIR = "editor/dist";

await mkdir(OUT_DIR, { recursive: true });

await Bun.build({
  entrypoints: [
    "editor/src/main.tsx",
    "lib/import-image/src/worker/omr.worker.ts",
  ],
  outdir: OUT_DIR,
  target: "browser",
  minify: true,
  // Flatten both entries to the dist root (main.js, omr.worker.js) so index.html
  // and omr-client.ts can reference them at the site root.
  naming: { entry: "[name].[ext]" },
});

const ortSource = "node_modules/onnxruntime-web/dist";
await mkdir(`${OUT_DIR}/ort`, { recursive: true });
for (const entry of await readdir(ortSource)) {
  if (entry.endsWith(".wasm") || entry.endsWith(".mjs")) {
    await cp(`${ortSource}/${entry}`, `${OUT_DIR}/ort/${entry}`);
  }
}

// pdf.js loads its worker by URL at runtime; serve it from the site root.
await cp(
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  `${OUT_DIR}/pdf.worker.min.mjs`,
);

// Copy static assets from lib/import-image/public/ if present. The model weights
// under public/models/ are deliberately excluded — they are served from Netlify
// Blobs (see lib/import-image/netlify/functions/models.mts), not the static
// deploy. Locally they stay in public/models/ and scripts/serve.ts serves them.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
const publicRoot = "lib/import-image/public";
if (await exists(publicRoot)) {
  await cp(publicRoot, OUT_DIR, {
    recursive: true,
    filter: (source) =>
      source !== `${publicRoot}/models` &&
      !source.startsWith(`${publicRoot}/models/`),
  });
}

await cp("editor/index.html", `${OUT_DIR}/index.html`);

console.log(
  "Built editor/dist/ (editor + OMR worker + index.html + ORT WASM + pdf.js worker)",
);
