/**
 * Combines the per-page note streams of a multi-page score into one flat list
 * whose measure indices run continuously across page boundaries.
 *
 * Each page is recognized independently, so every page numbers its measures from
 * 0. Concatenating the raw note lists would collapse page 2's measure 0 onto
 * page 1's measure 0. To stitch them into a single timeline we shift each page's
 * `measureIndex` past the measures already consumed by earlier pages.
 */
import type { NoteEvent } from "../types";

/**
 * The number of measures a page's notes span: one past its maximum
 * `measureIndex` (mirroring the builder, which sizes measures by the maximum
 * index since later staves renumber from 0). An empty page spans no measures.
 */
function measureSpan(notes: NoteEvent[]): number {
  let maxMeasureIndex = -1;
  for (const note of notes) {
    if (note.measureIndex > maxMeasureIndex) {
      maxMeasureIndex = note.measureIndex;
    }
  }
  return maxMeasureIndex + 1;
}

/**
 * Concatenate the note lists of consecutive pages, offsetting each page's
 * `measureIndex` by the total measures of all earlier pages so the combined
 * timeline is continuous. Pages that recognized nothing contribute no notes and
 * no measures (no blank measure is inserted for them).
 */
export function combinePages(pages: NoteEvent[][]): NoteEvent[] {
  const combined: NoteEvent[] = [];
  let measureOffset = 0;
  for (const notes of pages) {
    for (const note of notes) {
      combined.push({
        ...note,
        measureIndex: note.measureIndex + measureOffset,
      });
    }
    measureOffset += measureSpan(notes);
  }
  return combined;
}
