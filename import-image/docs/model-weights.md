# Model weights: how the served `v2` is produced from the public oemer models

This is the authoritative record of exactly what turns the publicly available
oemer ONNX weights into the weights this app serves (`MODEL_VERSION = "v2"`).
The short version: **one** transform — an `onnxsim` graph simplification with a
fixed input shape — and nothing else. The served weights are still full fp32 and
produce **bit-for-bit the same predictions** as the public release.

The weights are intended to stay static at `v2`. Speed work happens in the app
code (input resolution, tiling), not by re-optimizing or re-uploading the models.
A reduced-precision (fp16) variant was tried and reverted; see the end of this
file and `docs/model-optimization-plan.md`.

## 1. Source (public, MIT-licensed)

oemer's GitHub release, tag `checkpoints`
(`https://github.com/BreezeWhite/oemer/releases/download/checkpoints`):

| oemer file | role | architecture |
| --- | --- | --- |
| `1st_model.onnx` | staffline + symbol segmentation | `unet_big` |
| `2nd_model.onnx` | symbol-detail segmentation | `seg_net` |

Both are `tf2onnx 1.10.0`, **opset 9** exports. `make models`
(`scripts/download-models.ts`) downloads them into `public/models/` (gitignored,
~109 MB) under their versioned served file names (below). The exact source URLs
and file names live in `lib/models/manifest.ts`, the single source of truth.

## 2. The only transform: `make optimize-models`

`scripts/optimize-models.py` (run in the `python` Docker service) rewrites each
`public/models/*.onnx` **in place**. For each model it:

1. Reads the model's input tensor and **bakes the batch dimension to 1**, giving
   a fully static input shape (`manifest.inputShape`):
   - `unet_big`: `[1, 256, 256, 3]` (uint8, NHWC)
   - `seg_net`: `[1, 288, 288, 3]` (uint8, NHWC)
2. Runs `onnxsim.simplify` with that fixed shape, which **constant-folds** the
   ~1500 dynamic-shape nodes per model (`Shape` / `Gather` / `ConstantOfShape` /
   `Cast` / `Reshape` …):
   - `unet_big`: **1577 → 713** nodes
   - `seg_net`: **1619 → 719** nodes
3. **Asserts numerical equivalence**: it runs the original and the simplified
   graph on the same random input and fails unless `max|diff| ≤ 1e-4` (the spike
   measured exactly `0.0` — the fold is exact). So the deploy can never silently
   serve different predictions.

Why this transform exists: those dynamic-shape ops are not assigned to ORT-web's
WebGPU execution provider, so they ran on CPU mid-graph and forced a
GPU→CPU→GPU round-trip per tile — the dominant cost of the slow WebGPU pass.
Folding them away (which requires a fixed batch — a dynamic batch folds almost
nothing) is what made segmentation ~3.8× faster. Full detail and measurements:
`docs/model-optimization-plan.md`.

What is **not** changed: precision (stays fp32), the NHWC channel-last layout,
the I/O dtypes, the weights themselves, or the outputs (numerically identical).
Because the served graph bakes batch 1, the pipeline must feed exactly one tile
per inference (`src/worker/omr.worker.ts`, `manifest.inputShape[0]`).

## 3. Layout the rest of the pipeline relies on (unchanged from oemer)

Verified against the real weights:

- `unet_big` (`1st_model`): input name `input`, output name `prediction`,
  uint8 NHWC `256²×3` → `256²×3` softmax. Classes: `0` background, `1` staff,
  `2` symbols.
- `seg_net` (`2nd_model`): input name `input`, output name `conv2d_25`,
  uint8 NHWC `288²×3` → `288²×4` softmax. Classes: `0` background,
  `1` stems + rests, `2` noteheads, `3` clefs + keys.

## 4. Naming, versioning, serving

- Served file names embed `MODEL_VERSION` (`lib/models/manifest.ts`), e.g.
  `oemer-unet_big-staffline-symbol-seg.v2.onnx` and
  `oemer-seg_net-symbol-class-seg.v2.onnx`. The versioned name doubles as the
  Netlify Blobs key, the local cache file name, and the last URL segment, so each
  URL is immutable and cacheable forever.
- The weights are uploaded **once, out of band** to Netlify Blobs
  (`make upload-models`); a Netlify function streams them back same-origin at
  `/models/<file>` (required under COEP). Locally, `scripts/serve.ts` serves the
  same URLs straight from `public/models/`.
- To change weights (rare — they should stay static): bump `MODEL_VERSION`, then
  `make models && make optimize-models && make upload-models`. Keep the prior
  version's blobs so rollback is a one-line `MODEL_VERSION` revert + redeploy.

## 5. Reproducing `v2` from scratch

```sh
make models           # download 1st_model.onnx / 2nd_model.onnx from oemer
make optimize-models  # onnxsim + fixed shape, in place; asserts max|diff| ≈ 0
# public/models/*.onnx is now exactly the served v2.
```

## 6. What was tried and reverted

A full **fp16** conversion of the `v2` weights (`onnxconverter-common`) was
numerically near-perfect (~0.99998 pixel agreement vs fp32) but **regressed**
WebGPU speed badly — back to pre-Phase-1 per-tile times — because ORT-web's
WebGPU EP falls fp16 ops back to CPU mid-graph, even on a `shader-f16` device and
on current ORT-web (1.26), and even with a full-interior conversion. It was
rolled back and its tooling removed. fp16 is only worth revisiting behind runtime
`shader-f16` detection (serving fp32 to everyone else), never as a single served
artifact. See `docs/model-optimization-plan.md`.
