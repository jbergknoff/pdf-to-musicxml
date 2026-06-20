/**
 * Infers beam grouping for a measure's notes.
 *
 * TrOMR's rhythm vocabulary has no beam tokens, so beaming is not in the model
 * output — it is reconstructed here the way engravers do: consecutive beamable
 * notes (eighth and shorter) that fall within the same beat are joined under one
 * beam. This produces the `<beam>` elements MusicXML uses to draw the beams.
 *
 * Grouping is by beat, derived from the time signature: simple meters group per
 * denominator beat (4/4 → groups of two eighths per quarter), compound meters
 * (6/8, 9/8, 12/8) group per dotted-quarter (three eighths). Grouping by beat is
 * always musically valid — a beam never crosses a beat boundary.
 */
import type { NoteEvent } from "../types";
import { BEAM_COUNT, DIVISIONS, noteDivisions } from "./durations";

export type BeamType =
  | "begin"
  | "continue"
  | "end"
  | "forward hook"
  | "backward hook";

export interface BeamElement {
  /** Beam level: 1 = eighth beam, 2 = sixteenth, 3 = thirty-second. */
  number: number;
  type: BeamType;
}

/** A time position with its beam count, for one voice entry (not a chord tail). */
interface Entry {
  noteIndex: number;
  beams: number;
  start: number;
}

/** Divisions spanned by one beam group, from the time signature. */
function beamGroupSize(beats: number, beatType: number): number {
  const eighth = DIVISIONS / 2;
  // Compound meters (6/8, 9/8, 12/8) beam in dotted-quarter groups of three
  // eighths; 3/8 is a single such group too.
  if (beatType === 8 && beats % 3 === 0) {
    return 3 * eighth;
  }
  // Simple meters: one denominator beat (a quarter in x/4, a half in x/2).
  return (DIVISIONS * 4) / beatType;
}

/** Assign begin/continue/end (and hooks) across one run of beamable entries. */
function assignRun(
  run: Entry[],
  result: Map<number, BeamElement[]>,
): void {
  for (let index = 0; index < run.length; index++) {
    const entry = run[index];
    const elements: BeamElement[] = [];
    for (let level = 1; level <= entry.beams; level++) {
      const leftHas = index > 0 && run[index - 1].beams >= level;
      const rightHas = index < run.length - 1 && run[index + 1].beams >= level;
      let type: BeamType;
      if (leftHas && rightHas) {
        type = "continue";
      } else if (leftHas) {
        type = "end";
      } else if (rightHas) {
        type = "begin";
      } else {
        // A lone beam at this level: a hook. Point it back toward the previous
        // (longer) note when there is one — the dotted-eighth/sixteenth case —
        // otherwise forward. Level 1 never reaches here: a run is contiguous
        // beamable notes, so neighbors always share the primary beam.
        type = index > 0 ? "backward hook" : "forward hook";
      }
      elements.push({ number: level, type });
    }
    result.set(entry.noteIndex, elements);
  }
}

/**
 * Compute the beam elements for each note in a measure. Returns a map from the
 * note's index (in `notes`) to its `<beam>` elements; notes absent from the map
 * carry no beam (a lone eighth gets a flag, not a beam). Chord tail notes
 * (`chord: true`) and rests never carry beams.
 */
export function computeBeams(
  notes: NoteEvent[],
  beats: number,
  beatType: number,
): Map<number, BeamElement[]> {
  const result = new Map<number, BeamElement[]>();
  const groupSize = beamGroupSize(beats, beatType);

  // One entry per voice event; chord tail notes share the primary's time slot
  // and never advance the position or carry a beam.
  const entries: Entry[] = [];
  let position = 0;
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    if (note.chord) {
      continue;
    }
    const beams = note.pitch === "rest" ? 0 : BEAM_COUNT[note.duration];
    entries.push({ noteIndex: index, beams, start: position });
    position += noteDivisions(note);
  }

  // Walk runs of consecutive beamable entries that fall in the same beat group.
  let runStart = 0;
  while (runStart < entries.length) {
    if (entries[runStart].beams < 1) {
      runStart++;
      continue;
    }
    const groupIndex = Math.floor(entries[runStart].start / groupSize);
    let runEnd = runStart;
    while (
      runEnd + 1 < entries.length &&
      entries[runEnd + 1].beams >= 1 &&
      Math.floor(entries[runEnd + 1].start / groupSize) === groupIndex
    ) {
      runEnd++;
    }
    // A single beamable note in a beat is flagged, not beamed.
    if (runEnd > runStart) {
      assignRun(entries.slice(runStart, runEnd + 1), result);
    }
    runStart = runEnd + 1;
  }

  return result;
}
