import { describe, expect, it } from "bun:test";
import { decodeTokens } from "./decode-tokens";
import {
  BOS,
  EOS,
  PAD,
  NONOTE,
  PITCH_VOCAB,
  RHYTHM_VOCAB,
  LIFT_VOCAB,
} from "./vocabulary";

/** Find the token index for a string in a vocab array. */
function indexOf(vocab: readonly string[], token: string): number {
  const index = vocab.indexOf(token);
  if (index === -1) {
    throw new Error(`Token not found in vocab: "${token}"`);
  }
  return index;
}

describe("decodeTokens", () => {
  it("returns empty array when all tokens are EOS", () => {
    const result = decodeTokens([EOS], [EOS], [EOS]);
    expect(result).toEqual([]);
  });

  it("decodes a quarter note C4 with no accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchId = indexOf(PITCH_VOCAB, "C4");
    const liftId = indexOf(LIFT_VOCAB, "_"); // no accidental

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("C4");
    expect(result[0].duration).toBe("quarter");
    expect(result[0].dotted).toBe(false);
    expect(result[0].accidental).toBeNull();
    expect(result[0].measureIndex).toBe(0);
  });

  it("decodes a dotted half note G4", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_2.");
    const pitchId = indexOf(PITCH_VOCAB, "G4");
    const liftId = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].duration).toBe("half");
    expect(result[0].dotted).toBe(true);
    expect(result[0].pitch).toBe("G4");
  });

  it("decodes a whole note", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_1");
    const pitchId = indexOf(PITCH_VOCAB, "A4");
    const liftId = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].duration).toBe("whole");
    expect(result[0].dotted).toBe(false);
  });

  it("decodes a sharp accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchId = indexOf(PITCH_VOCAB, "F4");
    const liftId = indexOf(LIFT_VOCAB, "#");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].accidental).toBe("sharp");
  });

  it("decodes a flat accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchId = indexOf(PITCH_VOCAB, "B4");
    const liftId = indexOf(LIFT_VOCAB, "b");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].accidental).toBe("flat");
  });

  it("decodes a natural accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchId = indexOf(PITCH_VOCAB, "C4");
    const liftId = indexOf(LIFT_VOCAB, "N");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].accidental).toBe("natural");
  });

  it("decodes an eighth rest", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "rest_8");
    const pitchId = NONOTE; // "." nonote
    const liftId = NONOTE;

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].pitch).toBe("rest");
    expect(result[0].duration).toBe("eighth");
  });

  it("increments measureIndex at barline tokens", () => {
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const pitchD4 = indexOf(PITCH_VOCAB, "D4");
    const barline = indexOf(RHYTHM_VOCAB, "barline");
    const noAccidental = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    // note_4(C4) | barline(.) | note_4(D4) | EOS
    const rhythm = [quarterNote, barline, quarterNote, EOS];
    const pitch = [pitchC4, nonote, pitchD4, EOS];
    const lift = [noAccidental, nonote, noAccidental, EOS];

    const result = decodeTokens(rhythm, pitch, lift);
    expect(result).toHaveLength(2);
    expect(result[0].measureIndex).toBe(0);
    expect(result[1].measureIndex).toBe(1);
  });

  it("skips BOS tokens", () => {
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [BOS, quarterNote, EOS],
      [BOS, pitchC4, EOS],
      [BOS, noAcc, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("C4");
  });

  it("stops at EOS in the rhythm sequence", () => {
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [quarterNote, EOS, quarterNote],
      [pitchC4, pitchC4, pitchC4],
      [noAcc, noAcc, noAcc],
    );
    expect(result).toHaveLength(1);
  });

  it("stops at PAD in the rhythm sequence", () => {
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [quarterNote, PAD, quarterNote],
      [pitchC4, pitchC4, pitchC4],
      [noAcc, noAcc, noAcc],
    );
    expect(result).toHaveLength(1);
  });

  it("skips unsupported kern durations (tuplets)", () => {
    const tupletRhythm = indexOf(RHYTHM_VOCAB, "note_3"); // triplet, unsupported
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    const result = decodeTokens(
      [tupletRhythm, quarterNote, EOS],
      [nonote, pitchC4, EOS],
      [nonote, noAcc, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].duration).toBe("quarter");
  });

  it("emits grace notes (G suffix) with the grace flag", () => {
    const graceRhythm = indexOf(RHYTHM_VOCAB, "note_8G");
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchB4 = indexOf(PITCH_VOCAB, "B4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    // A grace note (with its own pitch) followed by a regular quarter note.
    const result = decodeTokens(
      [graceRhythm, quarterNote, EOS],
      [pitchB4, pitchC4, EOS],
      [noAcc, noAcc, EOS],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      pitch: "B4",
      duration: "eighth",
      grace: true,
    });
    // A regular note carries no grace flag.
    expect(result[1].pitch).toBe("C4");
    expect(result[1].grace).toBeUndefined();
  });

  it("skips non-note rhythm tokens (clef, key sig, time sig)", () => {
    const clef = indexOf(RHYTHM_VOCAB, "clef_G2");
    const keySig = indexOf(RHYTHM_VOCAB, "keySignature_0");
    const timeSig = indexOf(RHYTHM_VOCAB, "timeSignature/4");
    const quarterNote = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    const result = decodeTokens(
      [clef, keySig, timeSig, quarterNote, EOS],
      [nonote, nonote, nonote, pitchC4, EOS],
      [nonote, nonote, nonote, noAcc, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("C4");
    expect(result[0].duration).toBe("quarter");
  });

  it("maps a multi-measure rest to a whole rest", () => {
    const multirest = indexOf(RHYTHM_VOCAB, "rest_4m");
    const nonote = NONOTE;

    const result = decodeTokens([multirest, EOS], [nonote, EOS], [nonote, EOS]);
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("rest");
    expect(result[0].duration).toBe("whole");
  });

  it("chord token marks the following note_X as simultaneous", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const chord = indexOf(RHYTHM_VOCAB, "chord");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const pitchE4 = indexOf(PITCH_VOCAB, "E4");
    const pitchG4 = indexOf(PITCH_VOCAB, "G4");
    const noAcc = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    // C major chord: note_4(C4) chord note_4(E4) chord note_4(G4)
    // The chord token is a marker; the chord member's pitch comes with the
    // following note_X token.
    const result = decodeTokens(
      [note4, chord, note4, chord, note4, EOS],
      [pitchC4, nonote, pitchE4, nonote, pitchG4, nonote],
      [noAcc, nonote, noAcc, nonote, noAcc, nonote],
    );

    expect(result).toHaveLength(3);
    expect(result[0].pitch).toBe("C4");
    expect(result[0].chord).toBe(false);
    expect(result[0].duration).toBe("quarter");
    expect(result[1].pitch).toBe("E4");
    expect(result[1].chord).toBe(true);
    expect(result[1].duration).toBe("quarter");
    expect(result[2].pitch).toBe("G4");
    expect(result[2].chord).toBe(true);
    expect(result[2].duration).toBe("quarter");
  });

  it("chord flag is cleared at barlines", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const chord = indexOf(RHYTHM_VOCAB, "chord");
    const barline = indexOf(RHYTHM_VOCAB, "barline");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const pitchD4 = indexOf(PITCH_VOCAB, "D4");
    const noAcc = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    // chord marker followed by a barline: the barline clears the chord flag,
    // so the note after the barline is NOT a chord member.
    const result = decodeTokens(
      [note4, chord, barline, note4, EOS],
      [pitchC4, nonote, nonote, pitchD4, nonote],
      [noAcc, nonote, nonote, noAcc, nonote],
    );

    expect(result).toHaveLength(2);
    expect(result[0].chord).toBe(false);
    expect(result[1].chord).toBe(false);
    expect(result[1].measureIndex).toBe(1);
  });

  it("chord note measureIndex matches the measure where the chord marker appears", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const chord = indexOf(RHYTHM_VOCAB, "chord");
    const barline = indexOf(RHYTHM_VOCAB, "barline");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const pitchE4 = indexOf(PITCH_VOCAB, "E4");
    const pitchD4 = indexOf(PITCH_VOCAB, "D4");
    const noAcc = indexOf(LIFT_VOCAB, "_");
    const nonote = NONOTE;

    // Measure 0: C4 quarter; Measure 1: C4+E4 chord
    const result = decodeTokens(
      [note4, barline, note4, chord, note4, EOS],
      [pitchC4, nonote, pitchC4, nonote, pitchE4, nonote],
      [noAcc, nonote, noAcc, nonote, noAcc, nonote],
    );

    expect(result).toHaveLength(3);
    expect(result[0].measureIndex).toBe(0);
    expect(result[1].measureIndex).toBe(1);
    expect(result[1].chord).toBe(false);
    expect(result[2].measureIndex).toBe(1);
    expect(result[2].chord).toBe(true);
  });

  it("does not attach the opening attributes as a mid-staff change", () => {
    const clef = indexOf(RHYTHM_VOCAB, "clef_G2");
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [clef, note4, EOS],
      [NONOTE, pitchC4, EOS],
      [NONOTE, noAcc, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].attributeChange).toBeUndefined();
  });

  it("attaches a mid-staff clef change to the following note", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const clefF4 = indexOf(RHYTHM_VOCAB, "clef_F4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [note4, clefF4, note4, EOS],
      [pitchC4, NONOTE, pitchC4, EOS],
      [noAcc, NONOTE, noAcc, EOS],
    );
    expect(result).toHaveLength(2);
    expect(result[0].attributeChange).toBeUndefined();
    expect(result[1].attributeChange).toEqual({ clef: { sign: "F", line: 4 } });
  });

  it("attaches a key change at a measure start to that measure's first note", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const barline = indexOf(RHYTHM_VOCAB, "barline");
    const keySig = indexOf(RHYTHM_VOCAB, "keySignature_2");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    // The key signature appears after the barline but before the next note, so
    // the pending change must survive the barline.
    const result = decodeTokens(
      [note4, barline, keySig, note4, EOS],
      [pitchC4, NONOTE, NONOTE, pitchC4, EOS],
      [noAcc, NONOTE, NONOTE, noAcc, EOS],
    );
    expect(result).toHaveLength(2);
    expect(result[1].measureIndex).toBe(1);
    expect(result[1].attributeChange).toEqual({ keyFifths: 2 });
  });

  it("attaches a mid-staff time-signature change to the following note", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const timeTop = indexOf(RHYTHM_VOCAB, "timeSignature/3");
    const timeBottom = indexOf(RHYTHM_VOCAB, "timeSignature/4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [note4, timeTop, timeBottom, note4, EOS],
      [pitchC4, NONOTE, NONOTE, pitchC4, EOS],
      [noAcc, NONOTE, NONOTE, noAcc, EOS],
    );
    expect(result).toHaveLength(2);
    expect(result[1].attributeChange).toEqual({
      time: { beats: 3, beatType: 4 },
    });
  });

  it("drops a mid-staff change with no following note", () => {
    const note4 = indexOf(RHYTHM_VOCAB, "note_4");
    const clefF4 = indexOf(RHYTHM_VOCAB, "clef_F4");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const noAcc = indexOf(LIFT_VOCAB, "_");

    const result = decodeTokens(
      [note4, clefF4, EOS],
      [pitchC4, NONOTE, EOS],
      [noAcc, NONOTE, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].attributeChange).toBeUndefined();
  });
});
