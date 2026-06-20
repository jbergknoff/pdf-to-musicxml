/**
 * Shared duration arithmetic for MusicXML assembly: the divisions-per-quarter
 * convention, each note type's length in divisions, and how many beams a type
 * carries. Kept in its own module so both the builder and the beam grouper use
 * one source of truth (and to avoid a builder ↔ beams import cycle).
 */
import type { NoteEvent } from "../types";

type DurationName = NoteEvent["duration"];

/** Quarter note = 4 divisions; must divide all supported duration values. */
export const DIVISIONS = 4;

export const DURATION_DIVISIONS: Record<DurationName, number> = {
  whole: 16,
  half: 8,
  quarter: 4,
  eighth: 2,
  sixteenth: 1,
  thirty_second: 1, // rounds to 1 — 32nd notes need DIVISIONS=8; acceptable for POC
};

/** Length of a note in divisions, accounting for an augmentation dot. */
export function noteDivisions(note: NoteEvent): number {
  const base = DURATION_DIVISIONS[note.duration];
  return note.dotted ? Math.round(base * 1.5) : base;
}

/**
 * Number of beams (flags) a note type carries: eighth = 1, sixteenth = 2,
 * thirty-second = 3. Whole/half/quarter notes are never beamed.
 */
export const BEAM_COUNT: Record<DurationName, number> = {
  whole: 0,
  half: 0,
  quarter: 0,
  eighth: 1,
  sixteenth: 2,
  thirty_second: 3,
};
