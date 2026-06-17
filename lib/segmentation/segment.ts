import type {
  Mask,
  RgbaImage,
  SegmentationMasks,
  SegmentationModelSpec,
} from "../types";
import { argmaxClassMap, classMask } from "./masks";
import { runSegmentationModel, type SegmentationModel } from "./unet-session";

/**
 * Phase 1 segmentation: run both oemer models over one preprocessed page and
 * reduce their outputs to the five binary masks the later stages consume.
 *
 * The two models complement each other. `unet_big` (3 classes) finds where the
 * music is — stafflines vs. everything-symbolic. `seg_net` (4 classes) breaks
 * the symbols apart into stems/rests, noteheads, and clefs/keys. Callers should
 * preprocess (`resizeToPixelBudget`) first and run both models on that same
 * raster so the masks line up pixel-for-pixel.
 */

/**
 * Class layout of `unet_big` (the "1st" model). Channel order is fixed by the
 * trained weights; do not reorder.
 */
export const STAFF_SYMBOL_MODEL_SPEC: SegmentationModelSpec = {
  inputName: "input",
  outputName: "prediction",
  windowSize: 256,
  // 87.5% stride: ~30% fewer tiles than 75%; overlap is 32 px per seam, still
  // enough for the accumulator to smooth boundaries.
  stepSize: 224,
  channels: 3,
};

const STAFF_SYMBOL_CLASS = { staff: 1, symbols: 2 } as const;

/** Class layout of `seg_net` (the "2nd" model). */
export const SYMBOL_DETAIL_MODEL_SPEC: SegmentationModelSpec = {
  inputName: "input",
  outputName: "conv2d_25",
  windowSize: 288,
  // 87.5% stride: ~30% fewer tiles than 75%; overlap is 36 px, still smooth.
  stepSize: 252,
  channels: 4,
};

const SYMBOL_DETAIL_CLASS = {
  stemsRests: 1,
  noteheads: 2,
  clefsKeys: 3,
} as const;

/** The two models segmentation needs, already paired with their sessions. */
export interface SegmentationModels {
  staffSymbol: SegmentationModel;
  symbolDetail: SegmentationModel;
}

export interface SegmentOptions {
  /** Tiles inferred per backend call. */
  batchSize?: number;
  /** Reports overall progress in [0, 1] across both models. */
  onProgress?: (fraction: number) => void;
}

/**
 * Build {@link SegmentationModels} from sessions plus the canonical specs, so
 * callers only supply the two inference sessions.
 */
export function createSegmentationModels(
  staffSymbolSession: SegmentationModel["session"],
  symbolDetailSession: SegmentationModel["session"],
): SegmentationModels {
  return {
    staffSymbol: { spec: STAFF_SYMBOL_MODEL_SPEC, session: staffSymbolSession },
    symbolDetail: {
      spec: SYMBOL_DETAIL_MODEL_SPEC,
      session: symbolDetailSession,
    },
  };
}

/** The `unet_big` masks: where the music is, split staff vs. everything-else. */
export interface StaffSymbolMasks {
  width: number;
  height: number;
  staff: Mask;
  symbols: Mask;
}

/** The `seg_net` masks: the symbolic layer broken into its three classes. */
export interface SymbolDetailMasks {
  width: number;
  height: number;
  stemsRests: Mask;
  noteheads: Mask;
  clefsKeys: Mask;
}

/**
 * Run only the `unet_big` model and reduce it to its two masks. Split out from
 * {@link segment} so the two independent models can run in separate workers
 * (their masks don't interact), then be merged on the main thread.
 */
export async function segmentStaffSymbol(
  image: RgbaImage,
  model: SegmentationModel,
  options: SegmentOptions = {},
): Promise<StaffSymbolMasks> {
  const { width, height } = image;
  const probabilities = await runSegmentationModel(image, model, {
    batchSize: options.batchSize,
    label: "staff/symbol model",
    onProgress: options.onProgress,
  });
  const classes = argmaxClassMap(probabilities);
  return {
    width,
    height,
    staff: classMask(classes, width, height, STAFF_SYMBOL_CLASS.staff),
    symbols: classMask(classes, width, height, STAFF_SYMBOL_CLASS.symbols),
  };
}

/** Run only the `seg_net` model and reduce it to its three masks. */
export async function segmentSymbolDetail(
  image: RgbaImage,
  model: SegmentationModel,
  options: SegmentOptions = {},
): Promise<SymbolDetailMasks> {
  const { width, height } = image;
  const probabilities = await runSegmentationModel(image, model, {
    batchSize: options.batchSize,
    label: "symbol-detail model",
    onProgress: options.onProgress,
  });
  const classes = argmaxClassMap(probabilities);
  return {
    width,
    height,
    stemsRests: classMask(
      classes,
      width,
      height,
      SYMBOL_DETAIL_CLASS.stemsRests,
    ),
    noteheads: classMask(classes, width, height, SYMBOL_DETAIL_CLASS.noteheads),
    clefsKeys: classMask(classes, width, height, SYMBOL_DETAIL_CLASS.clefsKeys),
  };
}

export async function segment(
  image: RgbaImage,
  models: SegmentationModels,
  options: SegmentOptions = {},
): Promise<SegmentationMasks> {
  // Sequential composition of the two per-model passes, weighting their progress
  // evenly. The worker pipeline runs the same two passes concurrently instead.
  const staffSymbol = await segmentStaffSymbol(image, models.staffSymbol, {
    batchSize: options.batchSize,
    onProgress: (fraction) => options.onProgress?.(fraction * 0.5),
  });
  const symbolDetail = await segmentSymbolDetail(image, models.symbolDetail, {
    batchSize: options.batchSize,
    onProgress: (fraction) => options.onProgress?.(0.5 + fraction * 0.5),
  });

  return {
    width: image.width,
    height: image.height,
    staff: staffSymbol.staff,
    symbols: staffSymbol.symbols,
    stemsRests: symbolDetail.stemsRests,
    noteheads: symbolDetail.noteheads,
    clefsKeys: symbolDetail.clefsKeys,
  };
}
