/**
 * TrOMR token vocabularies for the six parallel output heads produced by the
 * Polyphonic-TrOMR decoder (NetEase, Apache-2.0), as used by the homr project.
 * These lists are pure data — not AGPL code — derived from homr's
 * `homr/transformer/vocabulary.py` `build_rhythm()`, `build_pitch()`,
 * `build_lift()`, and `build_slur()` functions. The ordering must exactly match
 * the vocabulary baked into the ONNX weights at training time (verified against
 * the served `tromr-decoder.v2.onnx`'s `out_slurs` output width, 5).
 *
 * Rhythm uses Humdrum **kern duration notation:
 *   1=whole, 2=half, 4=quarter, 8=eighth, 16=sixteenth, 32=thirty-second.
 *   A trailing "." means dotted; ".." means double-dotted; "G" means grace note.
 * Pitch uses note name + octave, e.g. "C4", in descending order (B9 first).
 * Lift encodes accidentals: "#"=sharp, "##"=double-sharp, "N"=natural,
 *   "b"=flat, "bb"=double-flat, "_"=no explicit accidental, "."=nonote.
 * Slur marks curved-line spans (both phrase slurs and ties — the model does not
 * distinguish them; a span whose endpoints share the same pitch is a tie, any
 * other pitch pair is a phrase slur, see `pairTies` in musicxml-builder.ts):
 *   "slurStart"/"slurStop" open/close a span, "slurStart_slurStop" closes one
 *   and opens another on the same note, "_"=no slur, "."=nonote.
 */

function buildRhythm(): readonly string[] {
  const rhythm: string[] = [];

  // Special sequence tokens
  rhythm.push("PAD", "BOS", "EOS");
  // Chord: marks a note simultaneous with the previous one
  rhythm.push("chord");

  // Barlines
  rhythm.push("barline", "doublebarline", "bolddoublebarline");
  rhythm.push("repeatStart", "repeatEnd", "repeatEndStart");
  rhythm.push("voltaStart", "voltaStop", "voltaDiscontinue");

  // Clefs: F3-F5, C1-C5, G1-G2
  for (let c = 3; c <= 5; c++) {
    rhythm.push(`clef_F${c}`);
  }
  for (let c = 1; c <= 5; c++) {
    rhythm.push(`clef_C${c}`);
  }
  for (let c = 1; c <= 2; c++) {
    rhythm.push(`clef_G${c}`);
  }

  // Key signatures: -7 (7 flats) to +7 (7 sharps)
  for (let c = -7; c <= 7; c++) {
    rhythm.push(`keySignature_${c}`);
  }

  // Time signatures
  for (const c of [1, 2, 3, 4, 6, 8, 12, 16, 32, 48]) {
    rhythm.push(`timeSignature/${c}`);
  }

  // Multi-measure rests: rest_2m through rest_10m
  for (let c = 2; c <= 10; c++) {
    rhythm.push(`rest_${c}m`);
  }

  // Kern base durations (14 values) × grace ("", "G") × dots ("", ".", "..")
  const kernBaseDurations = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 32, 64, 128];
  const kernValues: string[] = [];
  for (const d of kernBaseDurations) {
    for (const g of ["", "G"]) {
      for (const dot of ["", ".", ".."]) {
        kernValues.push(`${d}${g}${dot}`);
      }
    }
  }

  // Irregular (tuplet) durations
  const irregularDurations = [
    7, 11, 13, 18, 20, 21, 22, 24, 26, 28, 30, 34, 36, 40, 48, 56, 96,
  ];

  for (const d of kernValues) {
    rhythm.push(`note_${d}`);
  }
  for (const d of irregularDurations) {
    rhythm.push(`note_${d}`);
  }
  for (const d of kernValues) {
    rhythm.push(`rest_${d}`);
  }
  for (const d of irregularDurations) {
    rhythm.push(`rest_${d}`);
  }

  return rhythm;
}

function buildPitch(): readonly string[] {
  // nonote = "." (no pitch), empty = "_" (no pitch in context of a non-note symbol)
  const pitch: string[] = [".", "_"];
  const noteNames = ["C", "D", "E", "F", "G", "A", "B"];
  const notes: string[] = [];
  for (let octave = 0; octave <= 9; octave++) {
    for (const n of noteNames) {
      notes.push(`${n}${octave}`);
    }
  }
  // Reversed: highest pitch first (B9, A9, ..., C0)
  notes.reverse();
  pitch.push(...notes);
  return pitch;
}

function buildLift(): readonly string[] {
  // nonote=".": no accidental (applies to non-note symbols),
  // empty="_": note with no explicit accidental,
  // then the five accidental types.
  return [".", "_", "#", "##", "N", "b", "bb"];
}

function buildSlur(): readonly string[] {
  // nonote=".", empty="_", then a note that both closes and opens a span, then
  // a plain open/close.
  return [".", "_", "slurStart_slurStop", "slurStart", "slurStop"];
}

export const RHYTHM_VOCAB: readonly string[] = buildRhythm();
export const PITCH_VOCAB: readonly string[] = buildPitch();
export const LIFT_VOCAB: readonly string[] = buildLift();
export const SLUR_VOCAB: readonly string[] = buildSlur();

// Special token indices in the rhythm vocabulary (same positions as in homr)
export const PAD = 0; // "PAD"
export const BOS = 1; // "BOS"
export const EOS = 2; // "EOS"

// Nonote token index in pitch and lift (= 0 in both, since they start with ".")
export const NONOTE = 0;
