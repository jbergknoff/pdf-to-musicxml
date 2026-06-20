import type {
  RgbaImage,
  SegmentationMasks,
  SegmentationModelSpec,
} from "../types";
import { argmaxClassMap, classMask } from "./masks";
import {
  type RunSegmentationOptions,
  runSegmentationModel,
  type SegmentationModel,
} from "./unet-session";

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

export async function segment(
  image: RgbaImage,
  models: SegmentationModels,
  options: SegmentOptions = {},
): Promise<SegmentationMasks> {
  const { width, height } = image;

  // The two models run sequentially; weight their progress evenly.
  const staffSymbolOptions: RunSegmentationOptions = {
    batchSize: options.batchSize,
    label: "staff/symbol model",
    onProgress: (fraction) => options.onProgress?.(fraction * 0.5),
  };
  const symbolDetailOptions: RunSegmentationOptions = {
    batchSize: options.batchSize,
    label: "symbol-detail model",
    onProgress: (fraction) => options.onProgress?.(0.5 + fraction * 0.5),
  };

  const staffSymbolProbabilities = await runSegmentationModel(
    image,
    models.staffSymbol,
    staffSymbolOptions,
  );
  const staffSymbolClasses = argmaxClassMap(staffSymbolProbabilities);

  const symbolDetailProbabilities = await runSegmentationModel(
    image,
    models.symbolDetail,
    symbolDetailOptions,
  );
  const symbolDetailClasses = argmaxClassMap(symbolDetailProbabilities);

  return {
    width,
    height,
    staff: classMask(
      staffSymbolClasses,
      width,
      height,
      STAFF_SYMBOL_CLASS.staff,
    ),
    symbols: classMask(
      staffSymbolClasses,
      width,
      height,
      STAFF_SYMBOL_CLASS.symbols,
    ),
    stemsRests: classMask(
      symbolDetailClasses,
      width,
      height,
      SYMBOL_DETAIL_CLASS.stemsRests,
    ),
    noteheads: classMask(
      symbolDetailClasses,
      width,
      height,
      SYMBOL_DETAIL_CLASS.noteheads,
    ),
    clefsKeys: classMask(
      symbolDetailClasses,
      width,
      height,
      SYMBOL_DETAIL_CLASS.clefsKeys,
    ),
  };
}
