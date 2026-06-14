/**
 * Builds the SPA into dist/.
 *
 * Phase 0 goal: prove `bun build` can bundle ORT Web's threaded WASM glue. ORT
 * fetches its `.wasm` (and threaded `.mjs` workers) at runtime rather than
 * inlining them, so we copy those alongside the bundle under dist/ort/ and
 * point ORT at "/ort/" (see src/runtime/web-backend.ts).
 */
import { cp, mkdir, readdir } from "node:fs/promises";

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

await cp("index.html", "dist/index.html");

console.log("Built dist/ (bundle + index.html + ORT WASM under dist/ort/)");
