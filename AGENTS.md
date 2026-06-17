# Agent notes

## Project purpose

pdf-to-musicxml converts a PDF or image of printed sheet music into MusicXML
**entirely in the browser** — client-side Optical Music Recognition (OMR). The
input is a PDF/PNG/JPG of printed Western notation; the output is a downloadable
`.musicxml` file. No image ever leaves the device: all inference runs locally via
ONNX Runtime Web (WebGPU, WASM fallback), so the app ships as static files with
no backend. The recognition pipeline is segment → locate staves → transcribe
each staff with a transformer → assemble MusicXML, targeting the piano grand
staff (reached in phases, monophonic single staff first).

Design and full build plan live in `PLAN.md`. This file covers how to work in
the repo (tooling, conventions). Keep it current when the workflow changes.

## What exists now (Phases 0–2)

Phase 0 is the toolchain scaffold (see `PLAN.md` §6): `bun build` bundles ORT
Web's threaded WASM and the page is cross-origin isolated. Phase 1 adds
segmentation — the two oemer UNets running in the browser with their masks
overlaid on the page (`PLAN.md` §7). Phase 2 adds staff-structure detection —
recovering five-line staves and the unit size from the staff mask and drawing
them on the page.

Phase 0 foundation:

- `lib/runtime/inference-backend.ts` — runtime-agnostic inference interface, so
  `lib/` never imports a concrete ORT package. Browser impl in
  `src/runtime/web-backend.ts` (onnxruntime-web). `Tensor` carries a `type` tag
  (`float32`/`uint8`); the segmentation models take uint8 RGB patches.
- `src/main.tsx` — resolves the backend and mounts the app (only when the page
  is cross-origin isolated).
- `scripts/build.ts` — `bun build` the SPA into `dist/`; copy ORT `.wasm`/`.mjs`
  under `dist/ort/`, the pdf.js worker to the root, and anything in `public/`
  (including the model weights), plus `index.html`.
- `scripts/serve.ts` — static server for `dist/` that sets the COOP/COEP headers
  required for cross-origin isolation. Used by the Docker `server` service and
  `make dev`.

Phase 1 segmentation (all of `lib/` is runtime-agnostic and unit-tested):

- `lib/types.ts` — `RgbaImage`, `ProbabilityMap`, `Mask`, `SegmentationMasks`,
  `SegmentationModelSpec`.
- `lib/input/preprocess.ts` — `resizeToPixelBudget` rescales pages into oemer's
  ~3–4.35 M px training band (bilinear).
- `lib/segmentation/tiling.ts` — sliding-window tile geometry + overlap-averaging
  accumulator (mirrors oemer's `inference()`).
- `lib/segmentation/unet-session.ts` — drives one model over a page in batches
  via the injected `InferenceSession`.
- `lib/segmentation/masks.ts` — argmax → per-class binary masks.
- `lib/segmentation/segment.ts` — runs both models and maps their classes onto
  the five named masks. **Model layout (verified against the real weights):**
  `1st_model` (`unet_big`): uint8 NHWC `256²×3` → `256²×3` softmax
  (0 bg / 1 staff / 2 symbols). `2nd_model` (`seg_net`): uint8 NHWC `288²×3` →
  `288²×4` (0 bg / 1 stems+rests / 2 noteheads / 3 clefs+keys).
- `lib/segmentation/overlay.ts` — pure mask-compositing for the page overlay.
- `src/models/registry.ts` — fetches the weights from `/models/` (same-origin,
  required under COEP) and caches them in Cache Storage.
- `src/input/decode.ts` — File → `RgbaImage` (raster via `createImageBitmap`,
  PDF first page via pdf.js).
- `src/App.tsx` + `src/components/` — drop a score, run segmentation, overlay the
  masks with per-layer toggles.

Phase 2 staff structure (pure algorithm in `lib/staves/`, fully unit-tested):

- `lib/types.ts` — adds `Staff` (five staffline row centers, `unitSize`,
  `left`/`right` extent) and `StaffStructure` (staves + page-level `unitSize`).
- `lib/staves/staffline-detection.ts` — horizontal projection of the staff mask,
  thresholded and grouped into runs → one sub-pixel `StafflineRow` per line.
- `lib/staves/unit-size.ts` — `estimateUnitSize` (median consecutive gap; the
  many within-staff gaps outvote the few between-staff ones) plus a `median`
  helper.
- `lib/staves/detect-staves.ts` — orchestrates the two above: estimate the unit
  size, cut the lines into five-line staves (new staff at a large gap or every
  fifth line), drop non-five-line groups, and measure each staff's horizontal
  extent from a vertical projection over its own row band.
- `src/components/SegmentationView.tsx` strokes each detected staff's bounding
  box and five lines over the canvas (toggleable) and reports the staff count +
  unit size.

Worker (responsiveness — model loading + inference + staff detection run off
the main thread so the long WASM pass never freezes the UI):

- `src/worker/omr.worker.ts` — owns the inference backend and model weights. It
  waits for a `config` message (backend choice + profiling) before resolving its
  inference provider, then per request runs `segment` then `detectStaves`,
  streaming phase/fraction progress and posting the masks (buffers transferred)
  + staff structure back. Reports its provider after config so the UI can show
  it before any file drop.
- `src/worker/omr-client.ts` — main-thread handle that starts the worker, sends
  the `OmrConfig`, waits for the provider, and exposes `process(image,
  onProgress)` plus `dispose()`.
- `src/worker/protocol.ts` — the typed message protocol shared by both sides,
  including `OmrConfig` (`backend`: auto/webgpu/wasm, `profiling`).
- Inference options are UI-controlled, not URL flags: `src/components/
  InferenceSettings.tsx` is the backend picker + profiling toggle in the header.
  Because the backend/profiling can only be set before a session is built,
  changing either recreates the worker — `src/main.tsx`'s `Root` owns the
  `OmrConfig` and the client lifecycle, disposing and recreating the client when
  the config changes. Profiling flips ORT to verbose logging, which dumps the
  node->EP assignments at session load (the safe, CPU-side view of which ops
  fell back to CPU). ORT's WebGPU per-kernel profiling is intentionally left off
  — its GPU timestamp-queries crash this already-at-the-limit device.
- `src/main.tsx` mounts `Root` (gated on cross-origin isolation); `src/App.tsx`
  decodes the file on the main thread (pdf.js / canvas are DOM-bound), then
  hands the raster to the client (null while a fresh worker spins up).
- `scripts/build.ts` bundles the worker as a second entry point to
  `dist/omr.worker.js` (flattened naming), loaded via `new Worker(...)`.

The model weights (~109 MB, oemer's MIT release) are **not** committed. Run
`make models` to download them into `public/models/` (gitignored) before
`make build`/`make dev`.

## Local development

The only local requirements are `make` and `docker`. Bun, Biome, tsc, and
Playwright run inside containers via `docker compose`; nothing is installed on
the host. (On Netlify, `NETLIFY=true` makes the Makefile run the tools directly.)

```sh
make models           # download oemer ONNX weights -> public/models/ (local, once)
make upload-models    # upload weights to Netlify Blobs via the CLI (once, out of band)
make build            # bun build src/ -> dist/ (+ ORT wasm, pdf worker, public/)
make dev              # build, then rebuild on change (run `make up` to serve)
make up / make down   # start/stop the static server on :3456
make format           # biome format --write
make lint             # biome lint
make typecheck        # tsc --noEmit
make unit-test        # bun test src lib
make integration-test # Playwright: cross-origin isolation + provider check
make pr-ready         # format, lint, typecheck, build, unit-test
```

Run `make pr-ready` before committing. CI (`.github/workflows/ci.yml`) runs the
same target, then `git diff --exit-code` to fail if anything wasn't pre-formatted
(so always run `make format` first). `integration-test` is not in `pr-ready`
because it needs the Playwright browser image; it is the automated form of the
Phase 0 manual acceptance check and is run on demand.

## Conventions (carried from the sibling piano-practice repo)

- Full words in names — no abbreviations (`index` not `idx`, `previous` not
  `prev`).
- Braces around every conditional/loop body, even single-line.
- Components `PascalCase`; everything else `kebab-case`.
- `lib/` is framework- and runtime-agnostic (no Preact, no concrete ORT import);
  `src/` is the UI. The ORT runtime is injected via `InferenceBackend`.
- Commit `bun.lock` alongside `package.json` when dependencies change.
- `dist/` is gitignored and excluded from Biome.

## Deployment

Netlify builds with `make build` and deploys `dist/`; `netlify.toml` sets the
COOP/COEP headers in production. The Bun version is pinned via `BUN_VERSION` in
`netlify.toml`, and `docker-compose.yml` reads the same variable so both
environments stay in sync.

The model weights are **not** in the static deploy and **not** handled by the
build. They are uploaded **once, out of band** to a site-wide Netlify Blobs
store (`MODEL_STORE_NAME`) with the Netlify CLI — `make upload-models` downloads
them and runs `netlify blobs:set` per file (in a Node container, needs
`NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`). Deploy-time upload of the ~109 MB was
too slow. `netlify/functions/models.mts` reads that same store and streams the
weights back same-origin at `/models/<file>` (required under COEP). File names
are versioned (`lib/models/manifest.ts`, `MODEL_VERSION`) so each URL is
immutable — the function serves a long-lived cache header and the browser also
keeps the bytes in Cache Storage. Bump `MODEL_VERSION` (and re-run
`make upload-models`) to roll out new weights. `lib/models/manifest.ts` is the
shared source of truth for the browser registry, the upload script, and the
function. Locally there is no function, so `scripts/serve.ts` serves the same
`/models/<file>` URLs from `public/models/` (populated by `make models`).
