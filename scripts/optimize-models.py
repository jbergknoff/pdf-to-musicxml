"""
Optimize the oemer segmentation weights for the browser WebGPU path.

The released oemer ONNX exports (tf2onnx, opset 9) carry ~1500 dynamic-shape
nodes per model (Shape / Gather / ConstantOfShape / Cast / Reshape ...). Those
ops are not assigned to ORT-web's WebGPU EP, so they run on CPU mid-graph and
force a GPU->CPU->GPU round-trip per tile — the prime suspect for the ~3.7
min/page WebGPU segmentation pass. Freezing the input to a concrete shape lets
onnxsim constant-fold that machinery away, leaving (almost) only ops the WebGPU
EP runs on device.

This is a one-time, out-of-band ONNX->ONNX transform (run via
`make optimize-models`) — the bridge between the downloaded oemer originals and
the served weights, mirroring how `make upload-models` works rather than being
part of the per-build path. It rewrites each `public/models/*.onnx` in place,
but only after asserting the optimized graph is numerically identical to the
original on random input, so a deploy can never silently serve different
predictions.

A fixed batch is what unlocks the fold: leaving the batch dim dynamic folds
almost nothing, because the shape subgraphs are batch-dependent. We bake batch
N = 1 (matching `inputShape[0]` in lib/models/manifest.ts): every tile is a
full window, so a static shape is always valid, every dispatch stays small
(immune to both backends' big-batch failures), and the WebGPU pipeline cache
needs only one compiled kernel per op.

With `--fp16` the simplified graph is additionally converted to half precision
(`onnxconverter-common`, `keep_io_types=True` so the uint8 input and float32
output are untouched and only the interior runs at fp16). That is *lossy*, so the
bitwise check covers only the exact simplify step — the fp16 conversion's quality
is vetted separately by `make evaluate-models` (run it on the fp32 weights first,
before this `--fp16` pass rewrites them). On a WebGPU device advertising
`shader-f16` this roughly halves bandwidth on the compute-bound convs.

See docs/model-optimization-plan.md.

Requires: onnx, onnxsim, onnxruntime, numpy (and onnxconverter-common for
`--fp16`), installed in the `python` Docker service by `make optimize-models`.
"""

import argparse
import glob
import os
import sys
import warnings

import numpy as np
import onnx
import onnxruntime as ort
from onnxsim import simplify

MODELS_DIRECTORY = "public/models"

# The fixed batch baked into the served weights. Must match inputShape[0] for
# every model in lib/models/manifest.ts (the pipeline feeds exactly this many
# tiles per inference). H / W / C are read from each model itself, so they can
# never drift from the actual weights.
FIXED_BATCH_SIZE = 1

# The optimization is a pure constant-fold, so the spike measured max|diff| =
# 0.0. Allow a hair of float slack in case a future onnxsim reorders a reduction.
MAX_ABS_DIFF_TOLERANCE = 1e-4


def to_fp16(model: onnx.ModelProto) -> onnx.ModelProto:
    """Convert the simplified graph to half precision. `keep_io_types=True` pins
    the uint8 input and float32 output (so only two boundary casts remain and the
    lib needs no change), while `op_block_list=[]` forces *every* interior op to
    fp16 — no fp32 islands. The conservative default block list leaves some ops in
    fp32, and each island needs Cast pairs around it; on this graph those casts
    (or the blocked ops) fell off ORT-web's WebGPU EP and reintroduced the
    per-tile GPU<->CPU round-trips Phase 1 removed, regressing to pre-Phase-1
    speeds despite `shader-f16`. Forcing the whole interior to fp16 removes those
    islands. The conversion warns once per weight that underflows fp16's smallest
    normal — expected, vetted loss — so silence it. Import lazily so the default
    (lossless) path needs no extra dependency. MUST match evaluate-models.py's
    `fp16_graph` so the gate measures the served form."""
    from onnxconverter_common import float16

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        return float16.convert_float_to_float16(
            model, keep_io_types=True, op_block_list=[]
        )


def optimize(path: str, fp16: bool) -> None:
    model = onnx.load(path)
    graph_input = model.graph.input[0]
    input_name = graph_input.name

    # The originals already pin H / W / C; only the batch (leading) dim is
    # dynamic. Read the concrete dims and force the batch to FIXED_BATCH_SIZE.
    dims = [d.dim_value for d in graph_input.type.tensor_type.shape.dim]
    if len(dims) != 4:
        raise SystemExit(f"{path}: expected a 4-D input, got shape {dims}")
    fixed_shape = [FIXED_BATCH_SIZE, dims[1], dims[2], dims[3]]

    numpy_dtype = onnx.helper.tensor_dtype_to_np_dtype(
        graph_input.type.tensor_type.elem_type
    )

    nodes_before = len(model.graph.node)
    simplified, check_passed = simplify(
        model, overwrite_input_shapes={input_name: fixed_shape}
    )
    if not check_passed:
        raise SystemExit(f"{path}: onnxsim's own validation check failed")
    nodes_after = len(simplified.graph.node)

    # Hard numerical-equivalence gate: run the original and the simplified graph
    # on the same random input and assert they agree. The originals accept a
    # dynamic batch, so feeding the fixed shape is valid for both.
    if numpy_dtype == np.uint8:
        sample = np.random.randint(0, 256, size=fixed_shape, dtype=np.uint8)
    else:
        sample = np.random.rand(*fixed_shape).astype(numpy_dtype)

    original_session = ort.InferenceSession(
        model.SerializeToString(), providers=["CPUExecutionProvider"]
    )
    optimized_session = ort.InferenceSession(
        simplified.SerializeToString(), providers=["CPUExecutionProvider"]
    )
    original_output = original_session.run(None, {input_name: sample})[0]
    optimized_output = optimized_session.run(None, {input_name: sample})[0]
    max_abs_diff = float(np.abs(original_output - optimized_output).max())
    if max_abs_diff > MAX_ABS_DIFF_TOLERANCE:
        raise SystemExit(
            f"{path}: optimized graph diverges (max|diff| = {max_abs_diff}, "
            f"tolerance {MAX_ABS_DIFF_TOLERANCE})"
        )

    # The bitwise gate above proves the simplify step is exact. fp16 is lossy,
    # so it comes after the gate and is vetted instead by `make evaluate-models`.
    output = simplified
    precision = "fp32"
    if fp16:
        output = to_fp16(simplified)
        precision = "fp16"

    onnx.save(output, path)
    file_name = os.path.basename(path)
    print(
        f"  {file_name}: {nodes_before} -> {nodes_after} nodes, "
        f"input {fixed_shape}, {precision}, simplify max|diff| = {max_abs_diff}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fp16",
        action="store_true",
        help="Also convert the simplified graph to half precision (lossy; vet "
        "with `make evaluate-models` on the fp32 weights first).",
    )
    arguments = parser.parse_args()

    paths = sorted(glob.glob(os.path.join(MODELS_DIRECTORY, "*.onnx")))
    if not paths:
        raise SystemExit(
            f"No .onnx files in {MODELS_DIRECTORY}/ — run `make models` first."
        )
    precision = "fp16" if arguments.fp16 else "fp32"
    print(f"Optimizing {len(paths)} model(s) in {MODELS_DIRECTORY}/ ({precision})")
    for path in paths:
        optimize(path, arguments.fp16)
    if arguments.fp16:
        print("Done. Simplified + fp16 weights written in place; simplify step "
              "numerically verified, fp16 quality gated by `make evaluate-models`.")
    else:
        print("Done. Optimized weights written in place; numerically verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
