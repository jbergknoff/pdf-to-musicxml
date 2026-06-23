import { describe, expect, it } from "bun:test";
import type { NoteEvent } from "../types";
import { inferMeterFromStaves } from "./meter";

function note(
  measureIndex: number,
  duration: NoteEvent["duration"],
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch: "C4",
    accidental: null,
    duration,
    dotted: false,
    measureIndex,
    chord: false,
    ...extra,
  };
}

/** A run of `count` measures, each filled with `per` identical notes. */
function measures(
  count: number,
  per: number,
  duration: NoteEvent["duration"],
  extra: Partial<NoteEvent> = {},
): NoteEvent[] {
  const notes: NoteEvent[] = [];
  for (let measure = 0; measure < count; measure++) {
    for (let index = 0; index < per; index++) {
      notes.push(note(measure, duration, extra));
    }
  }
  return notes;
}

describe("inferMeterFromStaves", () => {
  it("reads 4/4 from measures of four quarter notes", () => {
    // 4 quarters = 16 divisions = 4/4.
    expect(inferMeterFromStaves([measures(5, 4, "quarter")])).toEqual({
      beats: 4,
      beatType: 4,
    });
  });

  it("reads 2/4 from measures of two quarter notes", () => {
    // 2 quarters = 8 divisions = 2/4 (the Mozart fixture's meter).
    expect(inferMeterFromStaves([measures(6, 2, "quarter")])).toEqual({
      beats: 2,
      beatType: 4,
    });
  });

  it("reads 3/4 from measures of twelve divisions", () => {
    // 3 quarters = 12 divisions = 3/4 (the Binchois fixture's meter).
    expect(inferMeterFromStaves([measures(8, 3, "quarter")])).toEqual({
      beats: 3,
      beatType: 4,
    });
  });

  it("resolves a compound 6/8 measure to its simple 3/4 equivalent", () => {
    // 6 eighths = 12 divisions, indistinguishable from 3/4 by length alone — we
    // document this collapse (the Saltarello fixture is really 6/8).
    expect(inferMeterFromStaves([measures(8, 6, "eighth")])).toEqual({
      beats: 3,
      beatType: 4,
    });
  });

  it("ignores a minority of short (note-dropped) measures", () => {
    // Five clean 4/4 measures plus two that dropped a note: the mode is still 16.
    const clean = measures(5, 4, "quarter");
    const dropped = [note(5, "quarter"), note(5, "quarter"), note(5, "quarter")];
    const dropped2 = [note(6, "quarter"), note(6, "quarter")];
    expect(inferMeterFromStaves([[...clean, ...dropped, ...dropped2]])).toEqual({
      beats: 4,
      beatType: 4,
    });
  });

  it("tallies every staff's measures together (grand staff)", () => {
    // Two hands, each four 2/4 measures: eight samples of length 8 → 2/4.
    const treble = measures(4, 2, "quarter");
    const bass = measures(4, 2, "quarter");
    expect(inferMeterFromStaves([treble, bass])).toEqual({
      beats: 2,
      beatType: 4,
    });
  });

  it("does not count chord-tail notes toward the measure length", () => {
    // Each measure: a quarter + a chord member (same onset) + two quarters = 3
    // sounding quarters = 12 divisions = 3/4, not 4/4.
    const notes: NoteEvent[] = [];
    for (let measure = 0; measure < 4; measure++) {
      notes.push(note(measure, "quarter"));
      notes.push(note(measure, "quarter", { chord: true }));
      notes.push(note(measure, "quarter"));
      notes.push(note(measure, "quarter"));
    }
    expect(inferMeterFromStaves([notes])).toEqual({ beats: 3, beatType: 4 });
  });

  it("returns undefined for a single measure (cannot establish a meter)", () => {
    // An unmetered chant is one long measure — never enough to infer from.
    expect(inferMeterFromStaves([measures(1, 27, "quarter")])).toBeUndefined();
  });

  it("returns undefined when no two measures agree", () => {
    const notes = [
      note(0, "quarter"),
      note(1, "quarter"),
      note(1, "quarter"),
      note(2, "quarter"),
      note(2, "quarter"),
      note(2, "quarter"),
    ];
    expect(inferMeterFromStaves([notes])).toBeUndefined();
  });

  it("returns undefined for an implausibly long modal measure", () => {
    // 13 quarters = 52 divisions → beats 13 > the cap; keep the default.
    expect(inferMeterFromStaves([measures(3, 13, "quarter")])).toBeUndefined();
  });

  it("returns undefined for no notes", () => {
    expect(inferMeterFromStaves([[]])).toBeUndefined();
    expect(inferMeterFromStaves([])).toBeUndefined();
  });
});
