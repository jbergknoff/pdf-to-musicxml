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

## What exists now (Phases 0–1)

Phase 0 is the toolchain scaffold (see `PLAN.md` §6): `bun build` bundles ORT
Web's threaded WASM and the page is cross-origin isolated. Phase 1 adds
segmentation — the two oemer UNets running in the browser with their masks
overlaid on the page (`PLAN.md` §7).

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

The model weights (~109 MB, oemer's MIT release) are **not** committed. Run
`make models` to download them into `public/models/` (gitignored) before
`make build`/`make dev`.

## Local development

The only local requirements are `make` and `docker`. Bun, Biome, tsc, and
Playwright run inside containers via `docker compose`; nothing is installed on
the host. (On Netlify, `NETLIFY=true` makes the Makefile run the tools directly.)

```sh
make models           # download oemer ONNX weights -> public/models/ (local, once)
make stage-models     # download + seed weights into .netlify/blobs/deploy/ (Netlify)
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

Netlify builds with `make stage-models build` and deploys `dist/`;
`netlify.toml` sets the COOP/COEP headers in production. The Bun version is
pinned via `BUN_VERSION` in `netlify.toml`, and `docker-compose.yml` reads the
same variable so both environments stay in sync.

The model weights are **not** in the static deploy. `make stage-models`
downloads them and writes them under `.netlify/blobs/deploy/`, which Netlify
seeds into the deploy's blob store; `netlify/functions/models.mts` then streams
them back same-origin at `/models/<file>` (required under COEP). File names are
versioned (`lib/models/manifest.ts`, `MODEL_VERSION`) so each URL is immutable —
the function serves a long-lived cache header, the browser also keeps the bytes
in Cache Storage, and Netlify de-duplicates the per-deploy blob upload by digest.
Bump `MODEL_VERSION` to roll out new weights. `lib/models/manifest.ts` is the
shared source of truth for the browser registry, the stage script, and the
function. Locally there is no function, so `scripts/serve.ts` serves the same
`/models/<file>` URLs from `public/models/` (populated by `make models`).
