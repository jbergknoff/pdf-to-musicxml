"""
Quality gate for reduced-precision (or otherwise transformed) segmentation
weights.

`scripts/optimize-models.py` asserts a *bitwise* equivalence (max|diff| = 0)
because onnxsim's constant-folding is numerically exact. The next optimization
levers in docs/model-optimization-plan.md — fp16 conversion first, possibly int8
later — are deliberately *not* exact: they trade a little precision for GPU
throughput. Phase 2 of the plan therefore requires a quality evaluation gate
before any such change can be served, so a faster model can never silently
degrade recognition.

This is that gate. For each served model it builds a candidate (by default the
fp16 conversion of the model; or an arbitrary alternate weights directory via
--candidate-dir), runs the reference and the candidate over the same real
sheet-music tiles, and compares their per-pixel argmax — the class map the rest
of the pipeline actually consumes. It reports, per output class, the
intersection-over-union of the two predictions plus the overall fraction of
pixels where they agree, and exits non-zero if any of those fall below a
threshold.

Why argmax-IoU on real tiles, not raw-output diff on random input (as the
optimize gate uses): a class flip is what changes a mask, and fp16 rounding only
matters where two class scores are close — which happens on real notation near
symbol edges, not on uniform noise. Because both models receive *identical*
pixels, this is a purely relative comparison, so the harness does not need to
reproduce the production preprocess/tiling exactly; it only needs realistic
content fed the same way to both.

This is a one-time, out-of-band check (run via `make evaluate-models`),
mirroring `optimize-models` / `upload-models` rather than being part of the
per-build path. It reads the served weights from public/models/ and sample
pages from samples/ (both gitignored, user-populated). See
docs/model-optimization-plan.md.

Requires: onnx, onnxruntime, onnxconverter-common, numpy, pillow (installed in
the `python` Docker service by `make evaluate-models`).
"""

import argparse
import datetime
import glob
import os
import sys
import warnings
from dataclasses import dataclass

import numpy as np
import onnx
import onnxruntime as ort
from onnxconverter_common import float16
from PIL import Image

MODELS_DIRECTORY = "public/models"
SAMPLES_DIRECTORY = "samples"

# Mirror lib/segmentation/segment.ts: tiles step at 87.5% of the window. The
# window size (and channel count) are read from each model itself, so only this
# ratio is duplicated here. Edge tiles are clamped flush to the image, matching
# planTiles in lib/segmentation/tiling.ts.
STRIDE_RATIO = 0.875

# oemer's training band lower bound, from lib/input/preprocess.ts. Pages are
# scaled toward this so tile content sits at the scale the models expect; exact
# agreement with the production resize is not required (see module docstring).
TARGET_PIXEL_COUNT = 3_000_000

# Defaults are conservative starting points, to be tuned once measured against
# real pages. fp16 on a well-behaved UNet typically agrees with fp32 on
# >99.9% of pixels; a class that genuinely shrinks/grows is what we want to
# catch. Override on the command line.
DEFAULT_MIN_AGREEMENT = 0.995
DEFAULT_MIN_CLASS_IOU = 0.98


def sample_paths() -> list[str]:
    """The sample pages the gate runs on, sorted. Raises if samples/ is empty —
    the gate needs real notation to surface class flips."""
    paths = sorted(
        path
        for pattern in ("*.png", "*.jpg", "*.jpeg")
        for path in glob.glob(os.path.join(SAMPLES_DIRECTORY, pattern))
    )
    if not paths:
        raise SystemExit(
            f"No sample pages in {SAMPLES_DIRECTORY}/ — drop a few PNG/JPG "
            "scans of printed sheet music there first (gitignored, like "
            "public/models/). The gate needs real notation to find class flips."
        )
    return paths


def load_sample_tiles(window_size: int, max_tiles: int | None) -> list[np.ndarray]:
    """Real sheet-music tiles for one window size: every page in samples/,
    scaled toward the training pixel budget, cut into window-sized uint8 NHWC
    patches with edge tiles clamped flush."""
    tiles: list[np.ndarray] = []
    for path in sample_paths():
        image = Image.open(path).convert("RGB")
        width, height = image.size
        pixels = width * height
        if pixels > TARGET_PIXEL_COUNT:
            scale = (TARGET_PIXEL_COUNT / pixels) ** 0.5
            image = image.resize(
                (max(window_size, round(width * scale)),
                 max(window_size, round(height * scale))),
                Image.BILINEAR,
            )
        array = np.asarray(image, dtype=np.uint8)
        height, width = array.shape[:2]

        for top in tile_origins(height, window_size):
            for left in tile_origins(width, window_size):
                tile = array[top:top + window_size, left:left + window_size, :]
                tiles.append(tile[np.newaxis, ...])
                if max_tiles is not None and len(tiles) >= max_tiles:
                    return tiles
    return tiles


def tile_origins(extent: int, window_size: int) -> list[int]:
    """Tile start coordinates along one axis: stride at STRIDE_RATIO of the
    window, with the last origin clamped so the final tile sits flush against
    the edge (mirrors planTiles)."""
    if extent <= window_size:
        return [0]
    step = max(1, round(window_size * STRIDE_RATIO))
    origins = list(range(0, extent - window_size + 1, step))
    last = extent - window_size
    if origins[-1] != last:
        origins.append(last)
    return origins


def make_session(model: onnx.ModelProto) -> ort.InferenceSession:
    return ort.InferenceSession(
        model.SerializeToString(), providers=["CPUExecutionProvider"]
    )


def fp16_graph(reference: onnx.ModelProto) -> onnx.ModelProto:
    """The true fp16 conversion of a model — the first reduced-precision lever
    the gate exists to vet. keep_io_types leaves the graph's I/O dtypes untouched
    (the uint8 input and a float32 output), so only the interior runs at half
    precision, the way the WebGPU EP would execute it.

    `op_block_list=[]` forces every interior op to fp16 (no fp32 islands), which
    MUST match optimize-models.py's `to_fp16` so the gate measures exactly the
    served form. The conversion warns once per weight that underflows fp16's
    smallest normal (clamped to ±min). That truncation is exactly the precision
    loss this gate measures, so it is expected, not a problem — silence it to keep
    the report readable."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        return float16.convert_float_to_float16(
            reference, keep_io_types=True, op_block_list=[]
        )


def fp16_weight_emulation(reference: onnx.ModelProto) -> onnx.ModelProto:
    """An fp32 graph whose float weights are rounded through fp16 — a CPU-runnable
    stand-in for `fp16_graph` when ORT's CPU EP has no fp16 kernel for an op (it
    historically lacks fp16 `Conv`). It captures weight-rounding error but not the
    per-op activation rounding of a true fp16 run, so it is a *lower* bound on the
    divergence; treat a failure here as definitive and a pass as suggestive."""
    emulated = onnx.ModelProto()
    emulated.CopyFrom(reference)
    for initializer in emulated.graph.initializer:
        if initializer.data_type == onnx.TensorProto.FLOAT:
            rounded = (
                onnx.numpy_helper.to_array(initializer)
                .astype(np.float16)
                .astype(np.float32)
            )
            initializer.CopyFrom(
                onnx.numpy_helper.from_array(rounded, initializer.name)
            )
    return emulated


def build_fp16_candidate(reference: onnx.ModelProto, input_name: str,
                         probe_tile: np.ndarray) -> tuple[ort.InferenceSession, str]:
    """Prefer the faithful fp16 graph; if the CPU EP can't build or run it, fall
    back to weight-rounding emulation, telling the caller which was used."""
    try:
        session = make_session(fp16_graph(reference))
        session.run(None, {input_name: probe_tile})
        return session, "fp16"
    except Exception as error:  # noqa: BLE001 — any ORT/build failure means fall back.
        print(f"    (CPU EP cannot run the true fp16 graph: {error};"
              " falling back to fp16 weight emulation)")
        return make_session(fp16_weight_emulation(reference)), "fp16 (weights emulated)"


def argmax_map(session: ort.InferenceSession, input_name: str, tile: np.ndarray):
    """Per-pixel winning class for one tile, as an [H, W] int array."""
    output = session.run(None, {input_name: tile})[0]
    return np.argmax(output[0], axis=-1)


@dataclass
class ModelResult:
    """One model's comparison, kept structured so the console output and the
    checked-in Markdown report render from the same numbers."""
    file_name: str
    candidate_label: str
    window_size: int
    tile_count: int
    agreement: float
    # Per-class IoU, indexed by class; None for a class absent from both sides.
    class_iou: list[float | None]
    passed: bool


def evaluate(path: str, candidate_directory: str | None,
             min_agreement: float, min_class_iou: float,
             max_tiles: int | None) -> ModelResult:
    reference = onnx.load(path)
    graph_input = reference.graph.input[0]
    input_name = graph_input.name
    dims = [d.dim_value for d in graph_input.type.tensor_type.shape.dim]
    if len(dims) != 4:
        raise SystemExit(f"{path}: expected a 4-D input, got shape {dims}")
    window_size = dims[1]

    file_name = os.path.basename(path)
    tiles = load_sample_tiles(window_size, max_tiles)
    reference_session = make_session(reference)

    if candidate_directory is None:
        candidate_session, candidate_label = build_fp16_candidate(
            reference, input_name, tiles[0]
        )
    else:
        candidate_path = os.path.join(candidate_directory, file_name)
        if not os.path.exists(candidate_path):
            raise SystemExit(f"{candidate_path}: no matching candidate weights")
        candidate_session = make_session(onnx.load(candidate_path))
        candidate_label = candidate_directory

    class_count = reference.graph.output[0].type.tensor_type.shape.dim[-1].dim_value
    intersection = np.zeros(class_count, dtype=np.int64)
    union = np.zeros(class_count, dtype=np.int64)
    agreeing_pixels = 0
    total_pixels = 0

    for tile in tiles:
        reference_classes = argmax_map(reference_session, input_name, tile)
        candidate_classes = argmax_map(candidate_session, input_name, tile)
        agreeing_pixels += int(np.count_nonzero(reference_classes == candidate_classes))
        total_pixels += reference_classes.size
        for class_index in range(class_count):
            reference_pixels = reference_classes == class_index
            candidate_pixels = candidate_classes == class_index
            intersection[class_index] += int(np.count_nonzero(reference_pixels & candidate_pixels))
            union[class_index] += int(np.count_nonzero(reference_pixels | candidate_pixels))

    agreement = agreeing_pixels / total_pixels if total_pixels else 1.0
    print(f"  {file_name}  vs {candidate_label}  ({len(tiles)} tiles, window {window_size})")
    print(f"    overall pixel agreement: {agreement:.5f}  (min {min_agreement})")

    passed = agreement >= min_agreement
    class_iou: list[float | None] = []
    for class_index in range(class_count):
        if union[class_index] == 0:
            class_iou.append(None)
            print(f"    class {class_index} IoU: absent")
            continue
        iou = intersection[class_index] / union[class_index]
        class_iou.append(iou)
        flag = "" if iou >= min_class_iou else "  << below threshold"
        print(f"    class {class_index} IoU: {iou:.5f}  (min {min_class_iou}){flag}")
        passed = passed and iou >= min_class_iou

    return ModelResult(
        file_name=file_name,
        candidate_label=candidate_label,
        window_size=window_size,
        tile_count=len(tiles),
        agreement=agreement,
        class_iou=class_iou,
        passed=passed,
    )


def write_report(report_path: str, results: list[ModelResult], samples: list[str],
                 candidate_directory: str | None, min_agreement: float,
                 min_class_iou: float, max_tiles: int | None) -> None:
    """Render the run as a Markdown record meant to be committed. Captures the
    inputs (candidate, thresholds, which sample pages) alongside the numbers, so
    a checked-in report is self-explaining even though samples/ is gitignored and
    the run is not reproducible from the repo alone."""
    candidate = "each model's fp16 conversion" if candidate_directory is None else candidate_directory
    overall = "PASS" if all(result.passed for result in results) else "FAIL"
    sample_names = ", ".join(os.path.basename(path) for path in samples)
    tile_note = f" (capped at {max_tiles} tiles/model)" if max_tiles is not None else ""

    lines = [
        "# Model evaluation results",
        "",
        "Generated by `make evaluate-models` (`scripts/evaluate-models.py`). "
        "Re-run and commit to refresh. The run is not reproducible from the repo "
        "alone — the sample pages live in the gitignored `samples/` — so the "
        "inputs are recorded below for context.",
        "",
        f"- Date: {datetime.date.today().isoformat()}",
        f"- Candidate: {candidate}",
        f"- Thresholds: overall agreement ≥ {min_agreement}, per-class IoU ≥ {min_class_iou}",
        f"- Samples ({len(samples)}): {sample_names}{tile_note}",
        f"- Result: **{overall}**",
        "",
    ]
    for result in results:
        lines.append(
            f"## `{result.file_name}` vs {result.candidate_label}"
        )
        lines.append("")
        lines.append(f"Window {result.window_size}, {result.tile_count} tiles. "
                     f"{'PASS' if result.passed else 'FAIL'}.")
        lines.append("")
        lines.append("| metric | value | min | |")
        lines.append("| --- | --- | --- | --- |")
        agreement_ok = "ok" if result.agreement >= min_agreement else "**below**"
        lines.append(
            f"| overall pixel agreement | {result.agreement:.5f} | {min_agreement} | {agreement_ok} |"
        )
        for class_index, iou in enumerate(result.class_iou):
            if iou is None:
                lines.append(f"| class {class_index} IoU | absent | {min_class_iou} | — |")
                continue
            status = "ok" if iou >= min_class_iou else "**below**"
            lines.append(f"| class {class_index} IoU | {iou:.5f} | {min_class_iou} | {status} |")
        lines.append("")

    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    with open(report_path, "w") as report_file:
        report_file.write("\n".join(lines))
    print(f"Wrote report to {report_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--candidate-dir",
        default=None,
        help="Directory of alternate weights to compare against (matched by "
        "file name). Defaults to comparing each model against its own fp16 "
        "conversion.",
    )
    parser.add_argument("--min-agreement", type=float, default=DEFAULT_MIN_AGREEMENT)
    parser.add_argument("--min-class-iou", type=float, default=DEFAULT_MIN_CLASS_IOU)
    parser.add_argument(
        "--max-tiles",
        type=int,
        default=None,
        help="Cap tiles per model (across all sample pages) for a quick check.",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Write a Markdown report to this path (meant to be committed). "
        "Omit for console output only.",
    )
    arguments = parser.parse_args()

    paths = sorted(glob.glob(os.path.join(MODELS_DIRECTORY, "*.onnx")))
    if not paths:
        raise SystemExit(
            f"No .onnx files in {MODELS_DIRECTORY}/ — run `make models` "
            "(and `make optimize-models`) first."
        )
    print(f"Evaluating {len(paths)} model(s) in {MODELS_DIRECTORY}/")
    results = [
        evaluate(
            path,
            arguments.candidate_dir,
            arguments.min_agreement,
            arguments.min_class_iou,
            arguments.max_tiles,
        )
        for path in paths
    ]

    if arguments.report is not None:
        write_report(
            arguments.report,
            results,
            sample_paths(),
            arguments.candidate_dir,
            arguments.min_agreement,
            arguments.min_class_iou,
            arguments.max_tiles,
        )

    if not all(result.passed for result in results):
        print("FAIL: a candidate degraded recognition beyond the threshold.")
        return 1
    print("PASS: all candidates within the quality threshold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
