/**
 * Core data types shared across the recognition pipeline.
 *
 * `lib/` is framework- and runtime-agnostic, so these are plain structural
 * types built on standard typed arrays — no canvas, DOM, or ORT references.
 */

/**
 * An interleaved RGBA raster, four bytes per pixel, row-major (the layout a
 * browser canvas yields via `getImageData`). This is the canonical image passed
 * from input decoding through preprocessing into segmentation.
 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A dense per-pixel probability map over `channels` classes, row-major and
 * channel-last (`value[y][x][c] = data[(y * width + x) * channels + c]`). This
 * is the averaged softmax output of a segmentation model before argmax.
 */
export interface ProbabilityMap {
  data: Float32Array;
  width: number;
  height: number;
  channels: number;
}

/** A binary mask, one byte per pixel (0 or 1), row-major. */
export interface Mask {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The five binary masks Phase 1 segmentation produces, all at the same
 * resolution. `staff`/`symbols` come from the first model (`unet_big`);
 * `stemsRests`/`noteheads`/`clefsKeys` from the second (`seg_net`).
 */
export interface SegmentationMasks {
  width: number;
  height: number;
  staff: Mask;
  symbols: Mask;
  stemsRests: Mask;
  noteheads: Mask;
  clefsKeys: Mask;
}

/**
 * One detected five-line staff. `lines` holds the row centers of its five
 * stafflines (top to bottom, fractional pixels); `unitSize` is this staff's
 * interline spacing (the scale reference everything downstream measures
 * against); `left`/`right` bound the stafflines horizontally (inclusive pixel
 * columns). The vertical extent is simply `lines[0]` to `lines[4]`.
 */
export interface Staff {
  lines: number[];
  unitSize: number;
  left: number;
  right: number;
}

/**
 * The staff layout detected on one page: the staves ordered top to bottom and a
 * representative interline spacing for the page (the median over the staves).
 */
export interface StaffStructure {
  staves: Staff[];
  unitSize: number;
}

/**
 * The fixed properties of an oemer segmentation model needed to drive tiled
 * inference. The models take square `windowSize`×`windowSize` uint8 RGB patches
 * (channel-last) and emit a `channels`-way softmax at the same resolution.
 */
export interface SegmentationModelSpec {
  /** Name of the model's single input tensor. */
  inputName: string;
  /** Name of the model's single output tensor. */
  outputName: string;
  /** Side length of the square input patch, in pixels. */
  windowSize: number;
  /** Stride between tile origins when scanning the page, in pixels. */
  stepSize: number;
  /** Number of output classes (channel-last softmax depth). */
  channels: number;
}

/**
 * A single musical event decoded from TrOMR's token sequence. Each note (or
 * rest) produced by one staff carries its pitch (or "rest"), duration, whether
 * the duration is dotted, and any accidental. `measureIndex` is the 0-based
 * measure the note falls in, derived from barline tokens.
 */
export interface NoteEvent {
  pitch: string | "rest";
  /** "natural" means no written accidental; null means the field was missing. */
  accidental:
    | "sharp"
    | "flat"
    | "natural"
    | "double_sharp"
    | "double_flat"
    | null;
  duration:
    | "whole"
    | "half"
    | "quarter"
    | "eighth"
    | "sixteenth"
    | "thirty_second";
  dotted: boolean;
  measureIndex: number;
  /** True when this note is simultaneous with the preceding note (MusicXML `<chord/>`). */
  chord: boolean;
}

/**
 * The leading score attributes recovered from one staff's token stream: the
 * opening clef, key signature, and time signature that precede its first note.
 * Every field is optional — TrOMR may not emit a given symbol, in which case the
 * builder falls back to its defaults (treble clef, C major, 4/4). Mid-staff
 * changes (a later clef or key change) are out of scope; only the opening
 * attributes are captured.
 */
export interface ScoreAttributes {
  /** Clef sign ("G"/"F"/"C") and staff line it sits on (1 = bottom line). */
  clef?: { sign: string; line: number };
  /** Key signature as a fifths count: negative = flats, positive = sharps. */
  keyFifths?: number;
  /** Time signature numerator (`beats`) over denominator (`beatType`). */
  time?: { beats: number; beatType: number };
}

/**
 * The fully decoded transcription of one staff: all note events in order,
 * segmented by the barline tokens TrOMR emitted. `rawRhythm` holds the
 * decoder's rhythm token strings (before note/rest filtering) for inspection.
 */
export interface Transcription {
  notes: NoteEvent[];
  measureCount: number;
  rawRhythm: string[];
  /** Leading clef/key/time recovered from this staff's tokens. */
  attributes: ScoreAttributes;
}
