import { describe, expect, it } from "bun:test";
import type { NoteEvent } from "../types";
import { type BeamElement, computeBeams } from "./beams";

function note(
  duration: NoteEvent["duration"],
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch: "C4",
    duration,
    dotted: false,
    accidental: "natural",
    measureIndex: 0,
    chord: false,
    ...extra,
  };
}

/** Beam types for a note index, or undefined when it carries no beam. */
function typesAt(
  beams: Map<number, BeamElement[]>,
  index: number,
): string[] | undefined {
  return beams.get(index)?.map((beam) => beam.type);
}

describe("computeBeams", () => {
  it("beams two eighth notes within a beat", () => {
    const beams = computeBeams([note("eighth"), note("eighth")], 4, 4);
    expect(beams.get(0)).toEqual([{ number: 1, type: "begin" }]);
    expect(beams.get(1)).toEqual([{ number: 1, type: "end" }]);
  });

  it("does not beam a lone eighth note", () => {
    // Eighth then quarter: the eighth is alone in its beat → flagged, not beamed.
    const beams = computeBeams([note("eighth"), note("quarter")], 4, 4);
    expect(beams.size).toBe(0);
  });

  it("never beams quarter or longer notes", () => {
    const beams = computeBeams([note("quarter"), note("half")], 4, 4);
    expect(beams.size).toBe(0);
  });

  it("splits eighths into per-beat groups in 4/4", () => {
    // Four eighths span two quarter beats → two beams of two.
    const beams = computeBeams(
      [note("eighth"), note("eighth"), note("eighth"), note("eighth")],
      4,
      4,
    );
    expect(typesAt(beams, 0)).toEqual(["begin"]);
    expect(typesAt(beams, 1)).toEqual(["end"]);
    expect(typesAt(beams, 2)).toEqual(["begin"]);
    expect(typesAt(beams, 3)).toEqual(["end"]);
  });

  it("emits two beam levels for a run of sixteenths", () => {
    const beams = computeBeams(
      [
        note("sixteenth"),
        note("sixteenth"),
        note("sixteenth"),
        note("sixteenth"),
      ],
      4,
      4,
    );
    expect(beams.get(0)).toEqual([
      { number: 1, type: "begin" },
      { number: 2, type: "begin" },
    ]);
    expect(beams.get(1)).toEqual([
      { number: 1, type: "continue" },
      { number: 2, type: "continue" },
    ]);
    expect(beams.get(3)).toEqual([
      { number: 1, type: "end" },
      { number: 2, type: "end" },
    ]);
  });

  it("uses a backward hook for the sixteenth of a dotted-eighth/sixteenth pair", () => {
    const beams = computeBeams(
      [note("eighth", { dotted: true }), note("sixteenth")],
      4,
      4,
    );
    expect(beams.get(0)).toEqual([{ number: 1, type: "begin" }]);
    expect(beams.get(1)).toEqual([
      { number: 1, type: "end" },
      { number: 2, type: "backward hook" },
    ]);
  });

  it("breaks beams across a rest", () => {
    const beams = computeBeams(
      [note("eighth"), note("eighth", { pitch: "rest" }), note("eighth")],
      4,
      4,
    );
    expect(beams.size).toBe(0);
  });

  it("beams a chord as one entry, skipping the chord tail notes", () => {
    // Eighth chord (C+E) then an eighth: two voice entries, one beam.
    const beams = computeBeams(
      [
        note("eighth"),
        note("eighth", { pitch: "E4", chord: true }),
        note("eighth"),
      ],
      4,
      4,
    );
    expect(beams.get(0)).toEqual([{ number: 1, type: "begin" }]);
    expect(beams.has(1)).toBe(false); // chord tail carries no beam
    expect(beams.get(2)).toEqual([{ number: 1, type: "end" }]);
  });

  it("groups eighths by dotted quarter in compound 6/8", () => {
    const beams = computeBeams(Array.from({ length: 6 }, () => note("eighth")), 6, 8);
    // Two groups of three.
    expect(typesAt(beams, 0)).toEqual(["begin"]);
    expect(typesAt(beams, 1)).toEqual(["continue"]);
    expect(typesAt(beams, 2)).toEqual(["end"]);
    expect(typesAt(beams, 3)).toEqual(["begin"]);
    expect(typesAt(beams, 4)).toEqual(["continue"]);
    expect(typesAt(beams, 5)).toEqual(["end"]);
  });
});
