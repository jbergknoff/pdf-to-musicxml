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

## What exists now (Phases 0–3)

Phase 0 is the toolchain scaffold (see `PLAN.md` §6): `bun build` bundles ORT
Web's threaded WASM and the page is cross-origin isolated. Phase 1 adds
segmentation — the two oemer UNets running in the browser with their masks
overlaid on the page (`PLAN.md` §7). Phase 2 adds staff-structure detection —
recovering five-line staves and the unit size from the staff mask and drawing
them on the page. Phase 3 adds TrOMR transcription and MusicXML assembly —
each detected staff is cropped, encoded by the TrOMR ConvNeXt encoder, decoded
autoregressively into rhythm/pitch/lift token triples, assembled into MusicXML
3.1 with chord support, and rendered in-browser via OSMD with a download button.

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
- `lib/input/preprocess.ts` — `resizeToPixelBudget` rescales pages (bilinear) to
  a fixed pixel budget. Deliberately set *below* oemer's ~3–4.35 M px training
  band (currently 1 M px) to trade accuracy for speed: time scales ~linearly with
  pixels, so fewer/smaller tiles run much faster on WebGPU. It's the main
  speed/accuracy knob — raise it back toward 3 M px to recover accuracy.
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
  PDF first page via pdf.js). `decodeFilePages` returns one raster *per* page —
  every page of a multi-page PDF, or a single-element array for a raster image —
  which the public `importFile` recognizes page by page (`decodeFile`, the
  single-page form, still backs the standalone `App.tsx` preview).
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

Phase 3 transcription + MusicXML assembly:

- `lib/types.ts` — adds `NoteEvent` (pitch, duration, dotted, accidental,
  measureIndex, chord) and `Transcription` (notes, measureCount, rawRhythm).
- `lib/transcription/staff-crop.ts` — crops each staff from the full-resolution
  image with unit-size padding, then scale-to-fits into the TrOMR encoder's
  fixed `256 × 1280` canvas, padding with white. Normalizes float32 grayscale
  to match homr's preprocessing: `(luma − 0.7931) / 0.1738`; staff is
  vertically centered, margins filled with the normalized white value.
- `lib/transcription/vocabulary.ts` — rhythm, pitch, and lift vocabularies
  loaded from the homr token files (BOS/EOS/PAD constants exported separately).
- `lib/transcription/tromr-session.ts` — drives the TrOMR encoder (ConvNeXt,
  `[1,1,256,1280]` → `[1,seq,512]`) and autoregressive decoder (8-layer
  transformer with a 32-tensor KV cache). Full encoder context is fed only on
  step 0; subsequent steps use the first 512 values (cross-attention KV is
  cached from step 0 — passing the full context again would re-derive it and
  exhaust WASM heap). Stops at EOS or a step cap.
- `lib/transcription/decode-tokens.ts` — turns three parallel token-ID arrays
  (rhythm / pitch / lift) into ordered `NoteEvent`s. The `chord` rhythm token
  is a **marker**: it sets a flag so the *following* `note_X` token is emitted
  with `chord: true` (and the same measure index). Durations cover whole through
  32nd (dotted variants included); barline tokens increment `measureIndex`;
  grace notes, tuplets, and unsupported tokens are skipped.
- `lib/transcription/transcribe.ts` — iterates over detected staves, calls
  `runTrOMR` then `decodeTokens` for each, collects `Transcription` results
  (including `rawRhythm` for the debug panel).
- `lib/assembly/musicxml-builder.ts` — assembles MusicXML 3.1 from a flat
  `NoteEvent[]`. Notes with `chord: true` get `<chord/>` before `<pitch>` so
  OSMD stacks them at the same time position. Empty measures get a whole-measure
  rest. Measure count is derived from the maximum `measureIndex` (not the last
  note's), since notes concatenated across staves each renumber measures from 0.
- `lib/assembly/combine-pages.ts` — `combinePages` concatenates the per-page
  note streams of a multi-page score, offsetting each page's `measureIndex` past
  the measures of earlier pages so the combined document has one continuous
  measure timeline. The public `importFile` (`index.ts`) drives the worker once
  per decoded page, flattens each page's transcriptions to notes, combines them,
  and builds a single MusicXML document (returning `""` when nothing was
  recognized, matching the worker's empty-result contract).
- `src/components/ScoreView.tsx` — renders MusicXML via OSMD and provides a
  download button for the `.musicxml` file.
- `src/components/TranscriptionDebug.tsx` — collapsible per-staff panel showing
  the staff crop canvas, raw rhythm token string, and decoded note list. Helps
  verify the transcription before OSMD renders it.

**Execution provider split:** segmentation and the TrOMR encoder run on WebGPU
when available. The **decoder is pinned to WASM** via `forceWasm: true` on its
session — ORT's WebGPU EP does not support the fused `SkipLayerNormalization`
op the decoder uses, and its many tiny autoregressive steps are dominated by
per-dispatch latency on WebGPU anyway. `InferenceBackend.createSession` accepts
an optional `CreateSessionOptions { forceWasm?: boolean }` for this.

**Resolution split:** segmentation runs on `resizeToPixelBudget(image)` (~1 Mpx)
for speed. TrOMR crops from the **full-resolution image** — the transformer was
trained on full-res staves, and blurring at 1 Mpx degrades notehead detection.
Staff coordinates detected in the segmentation-resolution space are scaled to
full-res in the worker before cropping.

Worker (responsiveness — model loading + inference + staff detection + TrOMR
transcription run off the main thread so the heavy WASM pass never freezes the UI):

- `src/worker/omr.worker.ts` — owns the inference backend and model weights. It
  waits for a `config` message before resolving its provider, then per request
  runs `segment` (on the downscaled image) → `detectStaves` → `transcribeStaves`
  (on the full-resolution image, with staff coordinates scaled up), streaming
  phase/fraction progress and posting masks + staff structure + MusicXML +
  transcription debug data back. Reports its provider after config so the UI
  can show it before any file drop.
- `src/worker/omr-client.ts` — main-thread handle that starts the worker, sends
  the `OmrConfig`, waits for the provider, and exposes `process(image,
  onProgress)` plus `dispose()`.
- `src/worker/protocol.ts` — the typed message protocol shared by both sides,
  including `OmrConfig` (`backend`: auto/webgpu/wasm).
- Inference options are UI-controlled, not URL flags: `src/components/
  InferenceSettings.tsx` is the backend picker in the header. Because the
  backend can only be set before a session is built, changing it recreates the
  worker — `src/main.tsx`'s `Root` owns the `OmrConfig` and the client
  lifecycle, disposing and recreating the client when the config changes.
  (There is no profiling toggle: ORT's only knobs here are unsafe on this
  device — verbose logging floods the console with a per-kernel line on every
  Run and crashes it, and WebGPU per-kernel profiling's GPU timestamp-queries
  crash the GPU process.)
- `src/main.tsx` mounts `Root` (gated on cross-origin isolation); `src/App.tsx`
  decodes the file on the main thread (pdf.js / canvas are DOM-bound), then
  hands the raster to the client (null while a fresh worker spins up).
- `scripts/build.ts` bundles the worker as a second entry point to
  `dist/omr.worker.js` (flattened naming), loaded via `new Worker(...)`.

The model weights (~109 MB, oemer's MIT release) are **not** committed. Run
`make models` to download them into `public/models/` (gitignored), then
`make optimize-models` to fold the served weights into their fast, fixed-shape
form (see below), before `make build`/`make dev`.

## Local development

The only local requirements are `make` and `docker`. Bun, Biome, tsc, and
Playwright run inside containers via `docker compose`; nothing is installed on
the host. (On Netlify, `NETLIFY=true` makes the Makefile run the tools directly.)

```sh
make models           # download oemer ONNX weights -> public/models/ (local, once)
make optimize-models  # onnxsim the weights to served v2 form (after models, out of band)
make upload-models    # upload weights to Netlify Blobs via the CLI (once, out of band)
make compare-resolutions # headless: low-vs-high-res pipeline agreement on samples/ (out of band)
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
keeps the bytes in Cache Storage. `lib/models/manifest.ts` is the shared source
of truth for the browser registry, the upload script, and the function. Locally
there is no function, so `scripts/serve.ts` serves the same `/models/<file>`
URLs from `public/models/` (populated by `make models` + `make optimize-models`).

The served weights are **not** the raw oemer originals: they are run through
`scripts/optimize-models.py` (`make optimize-models`), the one-time, out-of-band
bridge between "downloaded" and "served" — onnxsim with a fixed input shape baked
in (`manifest.inputShape`, batch 1). That folds away the ~1500 dynamic-shape ops
per model whose mid-graph CPU execution forced a GPU↔CPU round-trip per tile on
the WebGPU path; the script asserts the optimized graph is numerically *identical*
to the original before rewriting `public/models/` in place, so the served weights
predict bit-for-bit the same as the public oemer release. That graph
simplification is the **only** change applied to the public weights — the served
`v2` is full fp32 (an fp16 conversion was tried and reverted for regressing
WebGPU; see below). `docs/model-weights.md` is the authoritative, detailed record
of exactly how `v2` is produced. The pipeline feeds exactly `inputShape[0]` tiles
per inference (`src/worker/omr.worker.ts`).

The weights are intended to stay **static at `v2`**; speed work happens in the
app code (resolution, tiling) rather than by re-optimizing/re-uploading models.
If the weights ever genuinely change, roll out by bumping `MODEL_VERSION`, then
(out of band) `make models && make optimize-models && make upload-models`. The
version bump gives the bytes a fresh immutable URL; keep the previous version's
blobs in the store so rollback is a one-line `MODEL_VERSION` revert + redeploy.

`make compare-resolutions` is the headless validation for the resolution
speed/accuracy knob (`lib/input/preprocess.ts`): a Bun harness runs the real
`v2` pipeline (`segment` + `detectStaves`) over `samples/` (gitignored,
user-provided) at a high-resolution reference and lower candidate budgets, then
reports whether the detected staff structure (and segmentation masks) still
agree. Run it before lowering the pixel budget further. See
`docs/model-weights.md`.
