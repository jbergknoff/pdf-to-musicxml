import { describe, expect, it } from "bun:test";
import { decodeAttributes } from "./decode-attributes";
import { BOS, EOS, RHYTHM_VOCAB } from "./vocabulary";

/** Find the token index for a string in the rhythm vocab. */
function rhythm(token: string): number {
  const index = RHYTHM_VOCAB.indexOf(token);
  if (index === -1) {
    throw new Error(`Token not found in rhythm vocab: "${token}"`);
  }
  return index;
}

describe("decodeAttributes", () => {
  it("returns no attributes for an empty stream", () => {
    expect(decodeAttributes([EOS])).toEqual({});
  });

  it("recovers a treble clef", () => {
    const result = decodeAttributes([rhythm("clef_G2"), EOS]);
    expect(result.clef).toEqual({ sign: "G", line: 2 });
  });

  it("recovers a bass clef", () => {
    const result = decodeAttributes([rhythm("clef_F4"), EOS]);
    expect(result.clef).toEqual({ sign: "F", line: 4 });
  });

  it("recovers an alto (C) clef", () => {
    const result = decodeAttributes([rhythm("clef_C3"), EOS]);
    expect(result.clef).toEqual({ sign: "C", line: 3 });
  });

  it("recovers a sharp key signature as a positive fifths count", () => {
    const result = decodeAttributes([rhythm("keySignature_3"), EOS]);
    expect(result.keyFifths).toBe(3);
  });

  it("recovers a flat key signature as a negative fifths count", () => {
    const result = decodeAttributes([rhythm("keySignature_-2"), EOS]);
    expect(result.keyFifths).toBe(-2);
  });

  it("recovers a time signature from a numerator/denominator pair", () => {
    const result = decodeAttributes([
      rhythm("timeSignature/6"),
      rhythm("timeSignature/8"),
      EOS,
    ]);
    expect(result.time).toEqual({ beats: 6, beatType: 8 });
  });

  it("recovers clef, key, and time together", () => {
    const result = decodeAttributes([
      rhythm("clef_G2"),
      rhythm("keySignature_-1"),
      rhythm("timeSignature/3"),
      rhythm("timeSignature/4"),
      EOS,
    ]);
    expect(result).toEqual({
      clef: { sign: "G", line: 2 },
      keyFifths: -1,
      time: { beats: 3, beatType: 4 },
    });
  });

  it("skips a leading BOS token", () => {
    const result = decodeAttributes([BOS, rhythm("clef_F4"), EOS]);
    expect(result.clef).toEqual({ sign: "F", line: 4 });
  });

  it("stops scanning at the first note", () => {
    // A clef after the first note is a mid-staff change, out of scope here.
    const result = decodeAttributes([
      rhythm("clef_G2"),
      rhythm("note_4"),
      rhythm("clef_F4"),
      EOS,
    ]);
    expect(result.clef).toEqual({ sign: "G", line: 2 });
  });

  it("stops scanning at the first rest", () => {
    const result = decodeAttributes([
      rhythm("keySignature_2"),
      rhythm("rest_4"),
      rhythm("timeSignature/4"),
      rhythm("timeSignature/4"),
      EOS,
    ]);
    expect(result.keyFifths).toBe(2);
    expect(result.time).toBeUndefined();
  });

  it("keeps the first clef when two precede the notes", () => {
    const result = decodeAttributes([
      rhythm("clef_G2"),
      rhythm("clef_F4"),
      EOS,
    ]);
    expect(result.clef).toEqual({ sign: "G", line: 2 });
  });

  it("ignores an unpaired (ambiguous) time signature token", () => {
    const result = decodeAttributes([rhythm("timeSignature/4"), EOS]);
    expect(result.time).toBeUndefined();
  });
});
