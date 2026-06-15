/**
 * Builds the SPA into dist/.
 *
 * Bundles the app with `bun build`, then stages the runtime assets that are
 * fetched (not inlined) at run time:
 *   - ORT Web's `.wasm` / threaded `.mjs` under dist/ort/ (ORT points at /ort/).
 *   - pdf.js's worker bundle at the site root (decode.ts points at it).
 *   - anything under public/ (e.g. public/models/*.onnx) copied as-is, so the
 *     large model weights are served same-origin (required under COEP).
 */
import { cp, mkdir, readdir, stat } from "node:fs/promises";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  target: "browser",
  minify: true,
});

const ortSource = "node_modules/onnxruntime-web/dist";
await mkdir("dist/ort", { recursive: true });
for (const entry of await readdir(ortSource)) {
  if (entry.endsWith(".wasm") || entry.endsWith(".mjs")) {
    await cp(`${ortSource}/${entry}`, `dist/ort/${entry}`);
  }
}

// pdf.js loads its worker by URL at runtime; serve it from the site root.
await cp(
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "dist/pdf.worker.min.mjs",
);

// Copy static assets from public/ if present. The model weights under
// public/models/ are deliberately excluded — they are served from Netlify Blobs
// (see scripts/stage-models.ts + netlify/functions/models.mts), not the static
// deploy. Locally they stay in public/models/ and scripts/serve.ts serves them.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
if (await exists("public")) {
  await cp("public", "dist", {
    recursive: true,
    filter: (source) =>
      source !== "public/models" && !source.startsWith("public/models/"),
  });
}

await cp("index.html", "dist/index.html");

console.log("Built dist/ (bundle + index.html + ORT WASM + pdf.js worker)");
