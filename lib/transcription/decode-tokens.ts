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
 *   - "EOS" / "PAD"  → stop
 *   - anything else  → skip (clefs, key/time signatures, volta brackets, ...)
 *
 * Pitch tokens use "C4", "D5", etc. Lift tokens use "#", "##", "N", "b",
 * "bb", "_" (no accidental), or "." (nonote). Each rhythm token consumes one
 * corresponding pitch and lift token at the same index.
 */
import type { NoteEvent } from "../types";
import { EOS, LIFT_VOCAB, PAD, PITCH_VOCAB, RHYTHM_VOCAB } from "./vocabulary";

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
 * Returns null for unsupported durations (tuplets, grace notes, double-dotted).
 */
function parseNoteRestToken(
  token: string,
): { isRest: boolean; duration: DurationValue; dotted: boolean } | null {
  const isRest = token.startsWith("rest_");
  const suffix = token.slice(isRest ? 5 : 5); // strip "rest_" or "note_"

  // Multi-measure rest (rest_2m, rest_3m, …): emit as a single whole rest.
  if (isRest && suffix.endsWith("m")) {
    return { isRest: true, duration: "whole", dotted: false };
  }

  // Skip grace notes (contain "G") and double-dotted notes ("..").
  if (suffix.includes("G") || suffix.endsWith("..")) {
    return null;
  }

  const dotted = suffix.endsWith(".");
  const durationStr = dotted ? suffix.slice(0, -1) : suffix;
  const kernNum = Number(durationStr);
  if (!Number.isInteger(kernNum)) {
    return null;
  }

  const duration = KERN_TO_DURATION[kernNum];
  if (duration === undefined) {
    return null; // tuplet or unsupported kern number
  }

  return { isRest, duration, dotted };
}

/**
 * Decode three parallel token-ID arrays from the TrOMR decoder into an
 * ordered list of NoteEvents. The arrays must be aligned: index i in each
 * array corresponds to the same musical symbol.
 *
 * Barline tokens in the rhythm sequence increment `measureIndex` for
 * subsequent notes. Unsupported tokens (clefs, signatures, grace notes, …)
 * are silently skipped.
 */
export function decodeTokens(
  rhythmIds: ArrayLike<number>,
  pitchIds: ArrayLike<number>,
  liftIds: ArrayLike<number>,
): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let measureIndex = 0;
  let lastDuration: DurationValue = "quarter";
  let lastDotted = false;

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
      continue;
    }

    // Chord token: emit the current index's pitch/lift as a note simultaneous
    // with the previous one, inheriting its duration.
    if (rhythmToken === "chord") {
      const pitchToken = PITCH_VOCAB[pitchIds[i]] ?? ".";
      const liftToken = LIFT_VOCAB[liftIds[i]] ?? ".";
      if (pitchToken !== "." && pitchToken !== "_") {
        const accidental: AccidentalValue =
          LIFT_TO_ACCIDENTAL[liftToken] ?? null;
        notes.push({
          pitch: pitchToken,
          accidental,
          duration: lastDuration,
          dotted: lastDotted,
          measureIndex,
          chord: true,
        });
      }
      continue;
    }

    if (!rhythmToken.startsWith("note_") && !rhythmToken.startsWith("rest_")) {
      // Clef, key/time signature, volta, etc. — skip silently.
      continue;
    }

    const parsed = parseNoteRestToken(rhythmToken);
    if (parsed === null) {
      continue;
    }

    const pitchToken = PITCH_VOCAB[pitchIds[i]] ?? ".";
    const liftToken = LIFT_VOCAB[liftIds[i]] ?? ".";

    const pitch: string | "rest" = parsed.isRest ? "rest" : pitchToken;

    // Skip malformed note entries where pitch is nonote/empty but rhythm says note.
    if (!parsed.isRest && (pitchToken === "." || pitchToken === "_")) {
      continue;
    }

    const accidental: AccidentalValue = LIFT_TO_ACCIDENTAL[liftToken] ?? null;

    lastDuration = parsed.duration;
    lastDotted = parsed.dotted;

    notes.push({
      pitch,
      accidental,
      duration: parsed.duration,
      dotted: parsed.dotted,
      measureIndex,
      chord: false,
    });
  }

  return notes;
}
