import { describe, expect, it } from "bun:test";
import type { NoteEvent } from "../types";
import { combinePages } from "./combine-pages";

function note(pitch: string, measureIndex: number): NoteEvent {
  return {
    pitch,
    duration: "quarter",
    dotted: false,
    accidental: "natural",
    measureIndex,
    chord: false,
  };
}

describe("combinePages", () => {
  it("returns the notes unchanged for a single page", () => {
    const page = [note("C4", 0), note("D4", 1)];
    expect(combinePages([page])).toEqual(page);
  });

  it("offsets later pages past the measures of earlier ones", () => {
    const combined = combinePages([
      [note("C4", 0), note("D4", 1)],
      [note("E4", 0), note("F4", 1)],
    ]);
    expect(combined.map((n) => n.measureIndex)).toEqual([0, 1, 2, 3]);
    expect(combined.map((n) => n.pitch)).toEqual(["C4", "D4", "E4", "F4"]);
  });

  it("sizes a page's span by its maximum index, not its last note", () => {
    // A later staff renumbers measures from 0, so the final note can hold a
    // lower index than an earlier one. The offset must clear the maximum.
    const combined = combinePages([
      [note("C4", 0), note("D4", 1), note("E4", 0)],
      [note("F4", 0)],
    ]);
    // First page spans measures 0..1, so the second page starts at 2.
    expect(combined[combined.length - 1].measureIndex).toBe(2);
  });

  it("inserts no measures for a page that recognized nothing", () => {
    const combined = combinePages([
      [note("C4", 0)],
      [],
      [note("D4", 0)],
    ]);
    expect(combined.map((n) => n.measureIndex)).toEqual([0, 1]);
  });

  it("does not mutate the input note objects", () => {
    const original = note("C4", 0);
    combinePages([[note("A4", 0)], [original]]);
    expect(original.measureIndex).toBe(0);
  });

  it("returns an empty list for no pages", () => {
    expect(combinePages([])).toEqual([]);
  });
});
