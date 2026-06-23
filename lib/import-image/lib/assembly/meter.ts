/**
 * Infer a meter (time signature) from recovered note rhythms.
 *
 * TrOMR frequently emits no time-signature token for a staff, so the builder
 * would otherwise fall back to a blind 4/4 (see `musicxml-builder.ts`). That is
 * wrong whenever the real meter is anything else, and it mis-sizes every measure
 * (barlines, beam beats, whole-measure rests). When no meter was recovered we can
 * usually do better by reading it back out of the notes the OMR *did* recover:
 * in a correctly transcribed piece every full measure holds the same total
 * written duration, and that total pins down the measure length.
 *
 * The inference is the **most common** per-measure total across all the staves'
 * measures. Taking the mode (not the first or last measure) makes it robust to
 * the partial/corrupt measures dense scores produce — a handful of measures that
 * dropped a note sum short, but the many clean measures still outvote them. A
 * single measure is never enough (its length could be anything, e.g. an unmetered
 * chant or a pickup), so we require at least {@link MINIMUM_AGREEING_MEASURES}
 * measures to agree before trusting the result; otherwise the caller keeps its
 * plain default.
 *
 * **Known limitation — compound meters.** A measure length in divisions does not
 * distinguish a simple meter from its compound equivalent: 6/8 and 3/4 are both
 * twelve divisions, 9/8 and (dotted) 3/4 collide, etc. The rhythm-duration sum
 * alone cannot tell them apart (that needs the beaming/beat grouping, which TrOMR
 * does not emit), so we always resolve to the **simple** meter with a quarter-note
 * beat (beatType 4). A 6/8 piece is therefore inferred as 3/4 — same measure
 * length and barlines, just labelled simple. That is still strictly better than
 * the 4/4 default (which mis-sizes the measure), but it is why a 6/8 fixture's
 * time-signature affordance shrinks rather than disappearing.
 */
import type { NoteEvent } from "../types";
import { DIVISIONS, noteDivisions } from "./durations";

export interface Meter {
  beats: number;
  beatType: number;
}

// A single measure's length could be anything (an unmetered chant, a pickup, a
// final partial bar), so one measure never establishes a meter — require at
// least this many measures to share the modal length before trusting it.
const MINIMUM_AGREEING_MEASURES = 2;

// Cap the inferred numerator at a sane upper bound so a run of over-filled
// measures (a mis-segmented barline) cannot yield an absurd meter like 19/4;
// past this we keep the default rather than emit something nonsensical.
const MAXIMUM_BEATS = 12;

/**
 * Total written divisions per measure for one staff's note stream, keyed by
 * `measureIndex`. Chord-tail notes (`chord: true`) share the previous onset and
 * grace notes (`grace: true`) borrow a neighbor's time, so both add no length —
 * mirroring how the builder advances its measure cursor.
 */
function measureLengths(notes: NoteEvent[]): Map<number, number> {
  const lengths = new Map<number, number>();
  for (const note of notes) {
    if (note.chord || note.grace) {
      continue;
    }
    const current = lengths.get(note.measureIndex) ?? 0;
    lengths.set(note.measureIndex, current + noteDivisions(note));
  }
  return lengths;
}

/**
 * Map a measure length in divisions to a simple (quarter-beat) meter, or
 * undefined when it does not correspond to one (not a whole number of quarter
 * beats, or an implausible count). See the module note on compound meters.
 */
function meterForLength(length: number): Meter | undefined {
  if (length <= 0 || length % DIVISIONS !== 0) {
    return undefined;
  }
  const beats = length / DIVISIONS;
  if (beats < 1 || beats > MAXIMUM_BEATS) {
    return undefined;
  }
  return { beats, beatType: 4 };
}

/**
 * Infer the meter shared by a set of staff note streams (one per staff), or
 * undefined when there is not enough agreement to trust an inference. Pass every
 * staff that shares the meter — a single staff for a monophonic part, both hands
 * for a grand staff — so each staff's measures all count toward the tally.
 */
export function inferMeterFromStaves(
  staffNotes: NoteEvent[][],
): Meter | undefined {
  // Tally, across every staff's every measure, how many measures share each
  // total length. The most common length is the candidate measure length.
  const measuresPerLength = new Map<number, number>();
  for (const notes of staffNotes) {
    for (const length of measureLengths(notes).values()) {
      if (length <= 0) {
        continue;
      }
      measuresPerLength.set(length, (measuresPerLength.get(length) ?? 0) + 1);
    }
  }

  // The plurality length wins; ties break toward the longer measure (a dropped
  // note shortens a measure, so the true length is never the shorter of a tie).
  let bestLength = 0;
  let bestCount = 0;
  for (const [length, count] of measuresPerLength) {
    if (count > bestCount || (count === bestCount && length > bestLength)) {
      bestLength = length;
      bestCount = count;
    }
  }

  if (bestCount < MINIMUM_AGREEING_MEASURES) {
    return undefined;
  }
  return meterForLength(bestLength);
}
