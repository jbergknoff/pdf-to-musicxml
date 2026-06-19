# Plan: speed up WebGPU segmentation by optimizing the ONNX weights

Status: **Phase 1 + work reduction implemented** (2026-06-17). The offline
graph simplification, stride widening, and pixel-budget reduction all landed.
Measured on a real score page via WebGPU: **~3.7 min → 35.8 s** total, across
two rounds of improvement. A later **resolution drop to 1 M px** took a real page
to **~15 s** (see below). `MODEL_VERSION` is `v2` and is intended to stay
static — further speed work happens in the app code (resolution/tiling), not by
re-optimizing the weights. `docs/model-weights.md` records exactly how `v2` is
produced.

**fp16 was tried and abandoned (2026-06-18).** An fp16 conversion of the served
weights was numerically near-perfect (≈0.99998 pixel agreement vs fp32), but
serving it *regressed* WebGPU speed badly on the test device: **35.8 s → 126 s**,
with per-tile times (904 ms on the 256² model, 1666 ms on the 288²) back at the
pre-Phase-1 figures (~920 / ~1830 ms). That signature means the fp16 ops fall
back to CPU mid-graph, reintroducing the per-tile GPU↔CPU round-trips Phase 1
removed. It reproduced even on a `shader-f16` device and on current ORT-web
(1.26), and even with a full-interior conversion (no fp32 islands) — so it is an
ORT-web WebGPU fp16-kernel-coverage limitation, not something our conversion can
fix. Rolled back to `v2` and the fp16 tooling was removed; fp16 is only worth
revisiting behind runtime `shader-f16` detection (serving fp32 to everyone else),
never as a single served artifact.

## What landed (Phase 1 + work reduction)

- `scripts/optimize-models.py` + `make optimize-models` (a `python:3.11-slim`
  Docker service): onnxsim with the per-model fixed input shape, a hard
  numerical-equivalence assertion, rewriting `public/models/*.onnx` in place.
  The bridge between the downloaded oemer originals and the served weights.
- `lib/models/manifest.ts`: per-model `inputShape` (`[1,256,256,3]` /
  `[1,288,288,3]`) as the single source for the baked batch; `MODEL_VERSION` →
  `v2`.
- `src/worker/omr.worker.ts`: feeds the baked fixed batch (`inputShape[0] = 1`)
  instead of the old provider-specific batch sizes.
- `AGENTS.md`: documents the optimize step as part of the local and rollout
  flows.

**Phase 1 measured result (WebGPU, real score page):** ~3.7 min → **58.6 s**
(~3.8× speedup). Per-tile: 236.9 ms (staff/symbol, 256²) and 492.3 ms
(symbol detail, 288²) — down from ~920 ms and ~1830 ms. Confirms the
GPU↔CPU round-trip hypothesis: ops are now on the GPU EP.

**Work reduction (stride + pixel budget) — also landed:**

- `lib/input/preprocess.ts`: All three pixel-count constants set to exactly
  3,000,000 px (oemer's training lower bound). Pages above 3 M px are
  downscaled; pages below are upscaled. Previously the ceiling was 4.35 M px,
  driving larger pages to ~100 tiles/model.
- `lib/segmentation/segment.ts`: Step sizes widened from 75% to **87.5%**
  of the window: `staffSymbol.stepSize` 192 → **224** (32 px overlap),
  `symbolDetail.stepSize` 216 → **252** (36 px overlap). ~30% fewer tiles
  than the 75%-stride baseline.
- Tile counts at 3 M px (measured page, 1523×1970): **58** staff/symbol +
  **44** symbol detail.

**Work reduction measured result (WebGPU):** 58.6 s → **35.8 s** (~1.6×
further speedup from Phase 1 alone).

**Resolution reduction below the training band (landed 2026-06-18):** since
segmentation time is ~linear in pixel count and the project is willing to trade
some OMR accuracy for speed, the pixel budget was dropped from 3 M px to
**1 M px** (`lib/input/preprocess.ts`) — roughly a third of the tiles, so a
~3× cut in tile count on top of the above. This runs *below* oemer's trained
scale, so small symbols start to be missed; the budget is the main
speed/accuracy knob (raise back toward 3 M px to recover accuracy). This is the
surest WebGPU lever — pure compute reduction, no dependence on ORT-web fp16
kernel coverage. Measured wall-clock on a real page: **35.8 s → ~15 s** (20 + 20
tiles, per-tile cost unchanged at ~243 / ~494 ms — the models are now the wall).

**Resolution validated by `make compare-resolutions` (2026-06-18).** The headless
harness ran the real `v2` pipeline at a 3 M px reference and lower budgets over
two real pages (a 9-staff and a 10-staff piano score) and compared the detected
staff structure. Staff detection held to **1 M px** on both pages — same staff
count, stafflines within **≤0.1 interline units** of the 3 M px reference. The
first failure was at **0.75 M px**, where the 9-staff page lost a staff (8 vs 9);
the 10-staff page still passed. Notably it is *not* the busier music that fails
first: the page that dropped a staff is the sparser arrangement, but it has the
finer staff spacing (reference unit 11.7 px vs 12.8 px), so when downscaled its
stafflines thin out below the detector's threshold sooner — the limiting factor
is staff spacing, not note density. So **1 M px is both safe and the floor** for a
global default — below it, finely-engraved pages start dropping staves. (Mask IoU
is reported too but is informational and dominated by thin-line resampling jitter
unless dilated; staff structure is the trustworthy signal.) Net: the resolution
lever is tapped out at 1 M px; further speedup would need the model-level levers
below, which the project is avoiding.

Full run (mask IoU dilation-tolerant at ±2 px; the harness exits non-zero because
0.75 M px lost a staff on the finer-spaced page). Note the per-tile `[omr]` timings are
CPU-EP — the harness runs on onnxruntime-node, not WebGPU, so its wall-clock is
not the browser figure; it exists to compare *outputs* across resolutions, not to
measure speed:

```
$ make compare-resolutions
docker compose run --rm  main bun run scripts/download-models.ts
✓ oemer-unet_big-staffline-symbol-seg.v2.onnx already present
✓ oemer-seg_net-symbol-class-seg.v2.onnx already present
Models ready in public/models/
docker compose run --rm  main bun run scripts/compare-resolutions.ts
Comparing 4 candidate budget(s) against a 3.00 MP reference over 2 page(s).
Pass (gate): same staff count and stafflines within 0.5 interline units of the reference.
Mask IoU is informational, measured within ±2px.

[omr] staff/symbol model: 58 tiles (window 256, step 224, batch 1, 5 blank skipped)
[omr] staff/symbol model: 18154ms (313.0ms/tile)
[omr] symbol-detail model: 44 tiles (window 288, step 252, batch 1, 4 blank skipped)
[omr] symbol-detail model: 24581ms (558.6ms/tile)
samples/At the Bottom of the Night.png  (decoded 775x1011)
  reference 3.00 MP -> 1516x1978: 9 staves, unit 11.7px
[omr] staff/symbol model: 42 tiles (window 256, step 224, batch 1, 6 blank skipped)
[omr] staff/symbol model: 14667ms (349.2ms/tile)
[omr] symbol-detail model: 35 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 19617ms (560.5ms/tile)
  2.00 MP -> 1238x1615: PASS — 9 staves [count ok], max line dev 0.8px (0.07 units), unit 3.1% off
      mask IoU: staff 0.784, symbols 0.795, stemsRests 0.788, noteheads 0.876, clefsKeys 0.870
[omr] staff/symbol model: 35 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 11210ms (320.3ms/tile)
[omr] symbol-detail model: 30 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 15859ms (528.6ms/tile)
  1.50 MP -> 1072x1399: PASS — 9 staves [count ok], max line dev 0.9px (0.08 units), unit 0.6% off
      mask IoU: staff 0.756, symbols 0.768, stemsRests 0.787, noteheads 0.838, clefsKeys 0.811
[omr] staff/symbol model: 20 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 6379ms (319.0ms/tile)
[omr] symbol-detail model: 20 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 10633ms (531.7ms/tile)
  1.00 MP -> 876x1142: PASS — 9 staves [count ok], max line dev 1.0px (0.09 units), unit 2.8% off
      mask IoU: staff 0.733, symbols 0.704, stemsRests 0.745, noteheads 0.818, clefsKeys 0.796
[omr] staff/symbol model: 20 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 6206ms (310.3ms/tile)
[omr] symbol-detail model: 12 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 6230ms (519.2ms/tile)
  0.75 MP -> 758x989: FAIL — 8 staves [COUNT MISMATCH vs 9]
      mask IoU: staff 0.757, symbols 0.735, stemsRests 0.724, noteheads 0.837, clefsKeys 0.805

[omr] staff/symbol model: 63 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 21264ms (337.5ms/tile)
[omr] symbol-detail model: 48 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 27503ms (573.0ms/tile)
samples/Rondo Alla Turca.png  (decoded 772x1005)
  reference 3.00 MP -> 1518x1976: 10 staves, unit 12.8px
[omr] staff/symbol model: 48 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 16608ms (346.0ms/tile)
[omr] symbol-detail model: 35 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 19571ms (559.2ms/tile)
  2.00 MP -> 1239x1614: PASS — 10 staves [count ok], max line dev 0.8px (0.06 units), unit 0.6% off
      mask IoU: staff 0.779, symbols 0.843, stemsRests 0.816, noteheads 0.882, clefsKeys 0.793
[omr] staff/symbol model: 35 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 11279ms (322.2ms/tile)
[omr] symbol-detail model: 30 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 17819ms (594.0ms/tile)
  1.50 MP -> 1073x1397: PASS — 10 staves [count ok], max line dev 0.9px (0.07 units), unit 0.2% off
      mask IoU: staff 0.772, symbols 0.830, stemsRests 0.814, noteheads 0.876, clefsKeys 0.795
[omr] staff/symbol model: 20 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 6201ms (310.1ms/tile)
[omr] symbol-detail model: 20 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 11403ms (570.1ms/tile)
  1.00 MP -> 876x1141: PASS — 10 staves [count ok], max line dev 0.9px (0.07 units), unit 1.2% off
      mask IoU: staff 0.699, symbols 0.805, stemsRests 0.775, noteheads 0.856, clefsKeys 0.719
[omr] staff/symbol model: 20 tiles (window 256, step 224, batch 1, 0 blank skipped)
[omr] staff/symbol model: 6511ms (325.6ms/tile)
[omr] symbol-detail model: 12 tiles (window 288, step 252, batch 1, 0 blank skipped)
[omr] symbol-detail model: 6927ms (577.3ms/tile)
  0.75 MP -> 759x988: PASS — 10 staves [count ok], max line dev 1.5px (0.12 units), unit 0.0% off
      mask IoU: staff 0.693, symbols 0.799, stemsRests 0.746, noteheads 0.871, clefsKeys 0.707

FAIL: a candidate budget did not match the reference.
```

**Parallel-workers experiment (tried and reverted):** Running the two models
in separate workers to overlap GPU dispatch showed that the GPU is the wall.
Both workers slowed ~2× (236 ms/tile → 592 ms, 492 ms/tile → 701 ms) because
they compete for the same physical GPU; total wall-clock improved only ~1.4 s
(35.8 s → 34.4 s), within run-to-run variance. Reverted — the added complexity
bought nothing.

**Why further stride widening is a no-op at 3 MP:** Edge-clamping snaps the
last tile in each axis flush to the image edge regardless of stride. At 3 M px
resolution, widening from 87.5% to 93.75% yields identical tile counts for
both models on the measured page (the edge tile absorbs the difference). Going
further would risk misaligned edges rather than reducing tile count.

## Problem

WebGPU segmentation is ~3.7 min/page (~920 ms/tile on the 256² model, ~1830
ms/tile on the 288²). That is ~100× slower than a UNet this size should run on a
GPU. Earlier work established the crash is fixed (bounded batch) and that the
convolutions do run on WebGPU (JSEP), not on CPU — so the slowness is not a
conv-on-CPU fallback. ORT's own profiling can't be used to dig further on this
device (verbose logging floods/crashes the console; WebGPU per-kernel profiling
crashes the GPU process). So the weights were inspected offline instead.

## Evidence (measured against the actual weights)

Both models are old `tf2onnx 1.10.0`, **opset 9** exports, and are massively
bloated relative to the work they do:

| model | role | input (NHWC, uint8) | output | nodes | Conv/ConvT |
|---|---|---|---|---|---|
| `1st_model` (unet_big) | staff/symbol | `[?,256,256,3]` | `[?,256,256,3]` | **1577** | 49 / 8 |
| `2nd_model` (seg_net)  | symbol detail | `[?,288,288,3]` | `[?,288,288,4]` | **1619** | 36 / 4 |

The other ~1500 nodes per model are overhead, dominated by **dynamic-shape
machinery**: ~100 each of `Shape`, `Gather`, `ConstantOfShape`, `Reshape`, plus
~250 `Cast`, ~150 `Mul`, and ~95 `Transpose` (NHWC↔NCHW churn around each conv),
plus ~50 per-layer instance-norm blocks (`ReduceMean`/`Sub`/`ReduceSumSquare`/
`Div`).

The `Shape`/`Gather`/`ConstantOfShape` ops are exactly the ones ORT reports as
"not assigned to the preferred execution provider" — they run on **CPU**.
Because they sit mid-graph, every one forces a **GPU→CPU→GPU round-trip** per
tile. ~100 of them × 167 tiles/page is the prime suspect for the per-tile cost,
far more than the conv compute itself.

## Fix — Phase 1: offline graph simplification with a fixed input shape

Tooling: `onnx` + `onnx-simplifier` (onnxsim) + `onnxruntime` (Python). This is a
pure ONNX→ONNX transform of the released weights — **no access to oemer's source
TF model is needed**.

Running `onnxsim.simplify(model, overwrite_input_shapes={"input":[1,H,W,3]})`:

| model | nodes before → after | what's removed |
|---|---|---|
| `1st_model` | 1577 → **713** | all `Shape`/`Gather`/`ConstantOfShape`/`Cast` folded to constants |
| `2nd_model` | 1619 → **719** | same |

After simplification the remaining ops are `Conv`, `ConvTranspose`,
`BatchNormalization`, `Relu`, `ReduceMean`/`Sub`/`ReduceSumSquare`/`Div`,
`Reshape`, `Transpose`, `Concat`, `Softmax` — **all supported by ORT-web's
WebGPU EP**, so nothing should force a CPU sync any more.

Verified numerically exact: `max|original − simplified| = 0.0` on random uint8
input, at batch 1 and batch 4. (File size is ~unchanged: the weights dominate,
not the node count.)

**Why a fixed batch is required.** Leaving the batch dim dynamic and only fixing
the spatial dims folds almost nothing (`1619 → 1519`), because the shape
subgraphs are batch-dependent. Baking a concrete batch is what unlocks the
fold. Our tiles are always full-window (`planTiles` clamps edge tiles flush, so
they're always 256²/288²), so a fixed spatial shape is always valid.

## Pipeline impact (small)

- **Layout is unchanged.** Input stays NHWC `uint8 [N,H,W,3]`, output stays NHWC
  `[N,H,W,C]`. So `unet-session.ts` packing and `masks.ts`/`tiling.ts` output
  parsing need **no layout changes**. `detect-staves` etc. are untouched.
- **Only change: feed a fixed batch `N`.** Two options:
  - **Recommended: `N = 1`.** Set the batch size to 1 for the optimized models.
    Every inference is batch 1, so no padding is ever needed, shapes are fully
    static (best for WebGPU pipeline/shader caching — one compiled pipeline per
    kernel), and it's structurally immune to the oversized-buffer crash. Cost:
    ~167 inferences/page, each with its own readback. Since batch 4 vs 8 timed
    identically before, per-dispatch overhead isn't currently dominant.
  - **Alternative: `N = 4`** (fewer dispatches). Requires padding the final
    partial batch up to `N` with dummy tiles and discarding the extra outputs —
    a small change in `packBatch`/`runSegmentationModel`.
- The existing unit tests inject fake sessions, so they're unaffected by the
  weights change.

## Where it lives in the build

This is a one-time, out-of-band transform per weights change — mirroring how
`upload-models` already works — **not** part of the per-build path.

1. Add `scripts/optimize-models.py` run in a Python container (new
   `make optimize-models` target, alongside `make models`). It downloads the
   oemer originals (or reuses `download-models` output), runs onnxsim with the
   per-model fixed shapes, asserts numerical equivalence (fail if `max diff` >
   small tol), and writes the optimized files.
2. Store the fixed input shape per model in `lib/models/manifest.ts` so the
   optimize script and the pipeline agree on `N`/`H`/`W` from one source.
3. Bump `MODEL_VERSION` in the manifest (URLs are versioned + immutable, so this
   cache-busts the browser registry, Cache Storage, and the CDN).
4. Re-run `make upload-models` to push the optimized weights to Netlify Blobs.
   Keep the originals in the store so rollback is instant.
5. `download-models` keeps fetching the oemer originals; the optimize step is the
   bridge between "original" and "served".

## Verification

1. **Numerical equivalence** (already shown in the spike: `max diff = 0.0`) —
   keep it as a hard assertion in `optimize-models.py`.
2. **End-to-end masks**: run the pipeline on a sample page before/after; masks
   should be pixel-identical and the detected staff structure identical.
3. **Existing unit tests** continue to pass (they don't touch real weights).
4. **The payoff metric**: `segment` ms on WebGPU before/after, from the existing
   `[omr]` perf log. This is the number that decides success.

## Risks & rollback

- If, even with the sync-forcing ops gone, the device is still slow, that points
  at raw conv throughput on a weak GPU → go to Phase 2 (below) or reduce work
  (fewer tiles / lower resolution).
- Fixed batch needs last-batch handling; `N = 1` avoids it entirely.
- Rollback is a one-line `MODEL_VERSION` revert + redeploy; old URLs still
  resolve from Blobs.

## Phase 2 (further optimization avenues)

Phase 1 + work reduction achieved ~6× total speedup (3.7 min → 35.8 s); the
resolution drop to 1 M px took it further to ~15 s on a real page (20 + 20 tiles,
per-tile cost unchanged at ~243 / ~494 ms — i.e. the models are now the wall).

### Resolution: the chosen speed/accuracy knob

Segmentation time is ~linear in pixel count, and the project accepts some OMR
accuracy loss for speed, so the pixel budget (`lib/input/preprocess.ts`,
currently 1 M px, below oemer's 3 M px training floor) is the primary lever. It
is a pure app-code change — the served `v2` weights are untouched — so it needs
no re-optimization or re-upload. `make compare-resolutions` validates how far it
can be pushed: a headless Bun harness (onnxruntime-node) runs the real pipeline
over `samples/` at a high-res reference and lower candidate budgets and reports
whether the detected staff structure (and masks) still agree. See
`docs/model-weights.md`.

### Model-level levers (lower priority — would change the served weights)

These attack the per-tile cost rather than the tile count, but each would mutate
the served weights (re-optimize + re-upload), which the project is avoiding; they
are recorded for completeness.

- **fp16 conversion** — tried and abandoned (see the status note). Numerically
  safe but regressed WebGPU even on a `shader-f16` device on current ORT-web
  (1.26): the fp16 ops fall back to CPU mid-graph. An ORT-web kernel-coverage
  limitation, not fixable in our conversion. Only viable behind runtime
  `shader-f16` detection serving fp32 to everyone else.
- **int8 quantization** is *not* recommended for the WebGPU target: ORT-web's
  WebGPU EP has no efficient int8 conv path, so `ConvInteger`/`QDQ` ops fall back
  to CPU and reintroduce the per-tile GPU↔CPU round-trips Phase 1 deleted —
  likely a regression, not a speedup.
- **NHWC → NCHW end-to-end** to delete the ~95 `Transpose` nodes: requires
  `packBatch` to emit `[N,3,H,W]` and the output reader to consume `[N,C,H,W]`
  (lib change + test updates). fp32, no accuracy cost — the most promising
  per-tile lever if model-weight changes are ever revisited.
- **Opset upgrade (9 → 17+)** plus fusing the manual instance-norm blocks into
  `InstanceNormalization` and folding `Conv`+`BatchNormalization`, for fewer and
  faster kernels.

## Estimated effort

Phase 1: ~half a day — `optimize-models.py`, manifest shape + version bump,
batch-size wiring, and verification — plus the out-of-band re-upload of weights.
