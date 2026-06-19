"""
Optimize the oemer segmentation weights for the browser WebGPU path.

The released oemer ONNX exports (tf2onnx, opset 9) carry ~1500 dynamic-shape
nodes per model (Shape / Gather / ConstantOfShape / Cast / Reshape ...). Those
ops are not assigned to ORT-web's WebGPU EP, so they run on CPU mid-graph and
force a GPU->CPU->GPU round-trip per tile — the prime suspect for the ~3.7
min/page WebGPU segmentation pass. Freezing the input to a concrete shape lets
onnxsim constant-fold that machinery away, leaving (almost) only ops the WebGPU
EP runs on device.

This is the one-time, out-of-band ONNX->ONNX transform (run via
`make optimize-models`) that turns the downloaded oemer originals into the served
`v2` weights — the only change applied to them. It rewrites each
`public/models/*.onnx` in place, but only after asserting the optimized graph is
numerically *identical* to the original on random input, so the served weights
produce bit-for-bit the same predictions as the public oemer release. The served
weights stay full fp32 (an fp16 conversion was tried and reverted — it regressed
WebGPU; see docs/model-optimization-plan.md and docs/model-weights.md).

A fixed batch is what unlocks the fold: leaving the batch dim dynamic folds
almost nothing, because the shape subgraphs are batch-dependent. We bake batch
N = 1 (matching `inputShape[0]` in lib/models/manifest.ts): every tile is a
full window, so a static shape is always valid, every dispatch stays small
(immune to both backends' big-batch failures), and the WebGPU pipeline cache
needs only one compiled kernel per op.

See docs/model-weights.md (what produces v2) and docs/model-optimization-plan.md.

Requires: onnx, onnxsim, onnxruntime, numpy (installed in the `python` Docker
service by `make optimize-models`).
"""

import glob
import os
import sys

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


def optimize(path: str) -> None:
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

    onnx.save(simplified, path)
    file_name = os.path.basename(path)
    print(
        f"  {file_name}: {nodes_before} -> {nodes_after} nodes, "
        f"input {fixed_shape}, max|diff| = {max_abs_diff}"
    )


def main() -> None:
    paths = sorted(glob.glob(os.path.join(MODELS_DIRECTORY, "*.onnx")))
    if not paths:
        raise SystemExit(
            f"No .onnx files in {MODELS_DIRECTORY}/ — run `make models` first."
        )
    print(f"Optimizing {len(paths)} model(s) in {MODELS_DIRECTORY}/")
    for path in paths:
        optimize(path)
    print("Done. Optimized weights written in place; numerically verified.")


if __name__ == "__main__":
    sys.exit(main())
