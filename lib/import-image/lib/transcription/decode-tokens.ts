/**
 * Converts the three raw token-ID sequences produced by the TrOMR decoder
 * (rhythm, pitch, lift) into structured NoteEvents.
 *
 * The rhythm sequence drives the decoding loop. Each token is looked up in
 * RHYTHM_VOCAB and classified:
 *   - "note_X[G][.]" → a note with kern duration X (optionally dotted, grace)
 *   - "rest_X[G][.]" → a rest with kern duration X
 *   - "rest_Nm"      → a multi-measure rest (mapped to one whole rest)
 *   - "barline" / "doublebarline" / ... → increment measure index
 *   - "chord"        → note simultaneous with the previous one (kept as-is)
 *   - clef / key / time tokens → a mid-staff attribute change, accumulated and
 *     attached to the *following* note as `attributeChange` (the opening run
 *     before the first note is left to `decodeAttributes`)
 *   - "EOS" / "PAD"  → stop
 *   - anything else  → skip (volta brackets, ...)
 *
 * Pitch tokens use "C4", "D5", etc. Lift tokens use "#", "##", "N", "b",
 * "bb", "_" (no accidental), or "." (nonote). Each rhythm token consumes one
 * corresponding pitch and lift token at the same index. An optional fourth
 * parallel array, slur tokens, is consumed the same way and recorded on the
 * note as `slurStart`/`slurStop` (see musicxml-builder.ts's `pairTies` for how
 * that becomes a `<tie>`).
 */
import type { NoteEvent, ScoreAttributes } from "../types";
import {
  parseClefToken,
  parseKeyToken,
  parseTimeToken,
  resolveTime,
} from "./decode-attributes";
import {
  EOS,
  LIFT_VOCAB,
  PAD,
  PITCH_VOCAB,
  RHYTHM_VOCAB,
  SLUR_VOCAB,
} from "./vocabulary";

type DurationValue = NoteEvent["duration"];
type AccidentalValue = NoteEvent["accidental"];

// Humdrum kern number → standard duration name.
// kern uses the inverse: 1=whole, 2=half, 4=quarter, 8=eighth, etc.
const KERN_TO_DURATION: Readonly<Record<number, DurationValue | undefined>> = {
  0: "whole", // breve (2 × whole); mapped to whole for MusicXML compatibility
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "sixteenth",
  32: "thirty_second",
};

const LIFT_TO_ACCIDENTAL: Readonly<Record<string, AccidentalValue>> = {
  "#": "sharp",
  "##": "double_sharp",
  N: "natural",
  b: "flat",
  bb: "double_flat",
};

/** Barline-class rhythm tokens that increment the measure counter. */
const BARLINE_TOKENS = new Set([
  "barline",
  "doublebarline",
  "bolddoublebarline",
  "repeatStart",
  "repeatEnd",
  "repeatEndStart",
]);

/**
 * Parse a "note_X[G][.]" or "rest_X[G][.]" token.
 * Returns null for unsupported durations (tuplets, double-dotted).
 *
 * Grace notes (the "G" infix) are **emitted, not dropped**: a grace is still a
 * pitched note in the score, and the source-vs-recovered diff reads every
 * pitched note (graces included), so dropping them only costs recall. The grace
 * flag is carried through so the builder emits a proper zero-duration
 * `<grace/>` note — its pitch is recovered without adding any measure time.
 */
function parseNoteRestToken(token: string): {
  isRest: boolean;
  duration: DurationValue;
  dotted: boolean;
  grace: boolean;
} | null {
  const isRest = token.startsWith("rest_");
  const suffix = token.slice(isRest ? 5 : 5); // strip "rest_" or "note_"

  // Multi-measure rest (rest_2m, rest_3m, …): emit as a single whole rest.
  if (isRest && suffix.endsWith("m")) {
    return { isRest: true, duration: "whole", dotted: false, grace: false };
  }

  // Skip double-dotted notes ("..").
  if (suffix.endsWith("..")) {
    return null;
  }

  // A grace note carries a "G" before any dot ("note_8G", "note_16G."); strip it
  // and remember the flag.
  const grace = suffix.includes("G");
  const base = grace ? suffix.replace("G", "") : suffix;

  const dotted = base.endsWith(".");
  const durationStr = dotted ? base.slice(0, -1) : base;
  const kernNum = Number(durationStr);
  if (!Number.isInteger(kernNum)) {
    return null;
  }

  const duration = KERN_TO_DURATION[kernNum];
  if (duration === undefined) {
    return null; // tuplet or unsupported kern number
  }

  return { isRest, duration, dotted, grace };
}

/**
 * Decode three parallel token-ID arrays from the TrOMR decoder into an
 * ordered list of NoteEvents. The arrays must be aligned: index i in each
 * array corresponds to the same musical symbol.
 *
 * Barline tokens in the rhythm sequence increment `measureIndex` for
 * subsequent notes. Grace notes are emitted (with `grace: true`); unsupported
 * tokens (clefs, signatures, tuplets, …) are silently skipped.
 *
 * `slurIds` is optional (defaults to none, meaning no slur/tie recovery) so
 * existing three-array callers keep working unchanged.
 */
export function decodeTokens(
  rhythmIds: ArrayLike<number>,
  pitchIds: ArrayLike<number>,
  liftIds: ArrayLike<number>,
  slurIds: ArrayLike<number> = [],
): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let measureIndex = 0;
  // `chord` in TrOMR is a marker: "the next note_X token is simultaneous with
  // the previous note." The pitch/lift at the chord token position are nonote;
  // the chord member's pitch comes with the following note_X token.
  let nextNoteIsChord = false;

  // Clef/key/time tokens seen since the last note accumulate here and attach to
  // the next note as a mid-staff `attributeChange`. The run before the first
  // note is the staff's opening attributes (handled by `decodeAttributes`), so
  // it is consumed but not attached. First value within a run wins, matching
  // `decodeAttributes`.
  let firstNoteEmitted = false;
  let pendingClef: ScoreAttributes["clef"] | undefined;
  let pendingKeyFifths: number | undefined;
  let pendingTimeNumbers: number[] = [];

  for (let i = 0; i < rhythmIds.length; i++) {
    const rhythmId = rhythmIds[i];
    const rhythmToken = RHYTHM_VOCAB[rhythmId] ?? "";

    if (rhythmToken === "EOS" || rhythmToken === "PAD") {
      break;
    }
    if (rhythmToken === "BOS") {
      continue;
    }

    if (BARLINE_TOKENS.has(rhythmToken)) {
      measureIndex++;
      nextNoteIsChord = false;
      continue;
    }

    if (rhythmToken === "chord") {
      nextNoteIsChord = true;
      continue;
    }

    if (!rhythmToken.startsWith("note_") && !rhythmToken.startsWith("rest_")) {
      // Accumulate clef/key/time changes for the next note; skip everything else
      // (volta brackets, etc.). Persists across barlines, so a key change at the
      // start of a measure attaches to that measure's first note.
      if (rhythmToken.startsWith("clef_") && pendingClef === undefined) {
        const clef = parseClefToken(rhythmToken);
        if (clef !== null) {
          pendingClef = clef;
        }
      } else if (
        rhythmToken.startsWith("keySignature_") &&
        pendingKeyFifths === undefined
      ) {
        const fifths = parseKeyToken(rhythmToken);
        if (fifths !== null) {
          pendingKeyFifths = fifths;
        }
      } else if (rhythmToken.startsWith("timeSignature/")) {
        const number = parseTimeToken(rhythmToken);
        if (number !== null) {
          pendingTimeNumbers.push(number);
        }
      }
      continue;
    }

    const parsed = parseNoteRestToken(rhythmToken);
    if (parsed === null) {
      nextNoteIsChord = false;
      continue;
    }

    const pitchToken = PITCH_VOCAB[pitchIds[i]] ?? ".";
    const liftToken = LIFT_VOCAB[liftIds[i]] ?? ".";

    const pitch: string | "rest" = parsed.isRest ? "rest" : pitchToken;

    // Skip malformed note entries where pitch is nonote/empty but rhythm says note.
    if (!parsed.isRest && (pitchToken === "." || pitchToken === "_")) {
      nextNoteIsChord = false;
      continue;
    }

    const accidental: AccidentalValue = LIFT_TO_ACCIDENTAL[liftToken] ?? null;
    const isChord = nextNoteIsChord;
    nextNoteIsChord = false;

    const slurToken = SLUR_VOCAB[slurIds[i] ?? 0] ?? ".";
    const slurStart =
      !parsed.isRest &&
      (slurToken === "slurStart" || slurToken === "slurStart_slurStop");
    const slurStop =
      !parsed.isRest &&
      (slurToken === "slurStop" || slurToken === "slurStart_slurStop");

    // Resolve the attribute tokens accumulated since the last note. The opening
    // run (before the first note) is consumed here but not attached — it belongs
    // to the document's opening attributes, not a mid-staff change.
    const change: ScoreAttributes = {};
    if (pendingClef !== undefined) {
      change.clef = pendingClef;
    }
    if (pendingKeyFifths !== undefined) {
      change.keyFifths = pendingKeyFifths;
    }
    const pendingTime = resolveTime(pendingTimeNumbers);
    if (pendingTime !== undefined) {
      change.time = pendingTime;
    }
    const hasChange =
      pendingClef !== undefined ||
      pendingKeyFifths !== undefined ||
      pendingTime !== undefined;
    pendingClef = undefined;
    pendingKeyFifths = undefined;
    pendingTimeNumbers = [];

    const note: NoteEvent = {
      pitch,
      accidental,
      duration: parsed.duration,
      dotted: parsed.dotted,
      measureIndex,
      chord: isChord,
    };
    if (parsed.grace) {
      note.grace = true;
    }
    if (slurStart) {
      note.slurStart = true;
    }
    if (slurStop) {
      note.slurStop = true;
    }
    if (firstNoteEmitted && hasChange) {
      note.attributeChange = change;
    }
    firstNoteEmitted = true;
    notes.push(note);
  }

  return notes;
}
