import { describe, expect, test } from "bun:test";
import {
  addNote,
  createBlankDocument,
  type NoteHandle,
  serializeDocument,
} from "./dom-edit";
import {
  beatFromX,
  chordForHandle,
  idForHandle,
  locateBeat,
  pickNote,
  pitchForHandle,
  pitchFromY,
  slotAt,
  slotAtBeat,
  slots,
  stepPitch,
} from "./hit-test";
import {
  computeCursorX,
  computeMeasureStartBeats,
  noteY,
  parseScore,
  type Pitch,
  resolveLayout,
} from "./sheet-music/index";

function blankLayout() {
  const score = parseScore(serializeDocument(createBlankDocument()));
  const layout = resolveLayout(score);
  const measureStartBeats = computeMeasureStartBeats(score);
  return { score, layout, measureStartBeats };
}

describe("beatFromX", () => {
  test("maps measure left edges to their start beats", () => {
    const { score, layout, measureStartBeats } = blankLayout();
    expect(
      beatFromX(layout.measureXs[0], score, layout, measureStartBeats),
    ).toBe(0);
    expect(
      beatFromX(layout.measureXs[1], score, layout, measureStartBeats),
    ).toBe(measureStartBeats[1]);
  });

  test("resolves to the nearest spine onset, not a linear interpolation", () => {
    const doc = createBlankDocument();
    // Place a note at beat 2 (the 3rd quarter of a 4/4 measure).
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const score = parseScore(serializeDocument(doc));
    const layout = resolveLayout(score);
    const measureStartBeats = computeMeasureStartBeats(score);
    // The note's actual x from the forward cursor map.
    const noteX = computeCursorX(2, score, layout, measureStartBeats);
    if (noteX === null) {
      throw new Error("expected a valid cursor x for beat 2");
    }
    expect(beatFromX(noteX, score, layout, measureStartBeats)).toBe(2);
    // A click slightly to the right of the notehead still resolves to beat 2.
    expect(beatFromX(noteX + 8, score, layout, measureStartBeats)).toBe(2);
  });
});

describe("locateBeat", () => {
  test("splits an absolute beat into measure + onset", () => {
    const { measureStartBeats } = blankLayout();
    expect(locateBeat(0, measureStartBeats)).toEqual({
      measureIndex: 0,
      onsetBeatInMeasure: 0,
    });
    expect(locateBeat(5, measureStartBeats)).toEqual({
      measureIndex: 1,
      onsetBeatInMeasure: 1,
    });
  });
});

describe("pitchFromY", () => {
  test("inverts noteY for a range of pitches (treble)", () => {
    const { layout } = blankLayout();
    const clef = { sign: "G" as const, line: 2 };
    const staffBottomY = layout.staffBottomYs[0];
    const pitches: Pitch[] = [
      { step: "E", alter: 0, octave: 4 }, // bottom line
      { step: "B", alter: 0, octave: 4 }, // middle line
      { step: "F", alter: 0, octave: 5 }, // top line
      { step: "C", alter: 0, octave: 5 }, // a space
      { step: "C", alter: 0, octave: 6 }, // above the staff (ledger)
    ];
    for (const pitch of pitches) {
      const y = noteY(pitch, clef, staffBottomY, layout.staffSpace);
      expect(pitchFromY(y, staffBottomY, layout.staffSpace, clef)).toEqual(
        pitch,
      );
    }
  });
});

describe("pickNote", () => {
  test("returns the id and handle of a note at a clicked location", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const score = parseScore(serializeDocument(doc));

    expect(handle).not.toBeNull();
    const hit = pickNote(score, 0, { step: "C", alter: 0, octave: 5 });
    expect(hit).not.toBeNull();
    if (!hit || !handle) {
      throw new Error("expected a hit");
    }
    expect(hit.handle).toEqual(handle);
    expect(hit.id).toBe("p0-m1-n0-v0");
    // The id resolves back to the same handle.
    expect(idForHandle(score, hit.handle)).toBe(hit.id);
  });

  test("returns null when nothing is close enough", () => {
    const doc = createBlankDocument();
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const score = parseScore(serializeDocument(doc));
    // Far away in both beat and pitch.
    expect(pickNote(score, 3.5, { step: "C", alter: 0, octave: 3 })).toBeNull();
  });
});

// Build a blank score with notes at the given (onsetBeatInMeasure, pitch) and
// return the parsed score plus each note's handle.
function scoreWithNotes(
  notes: Array<{ onset: number; step: Pitch["step"]; octave: number }>,
): { score: ReturnType<typeof parseScore>; handles: NoteHandle[] } {
  const doc = createBlankDocument();
  const handles = notes.map(
    (note) =>
      addNote(doc, {
        measureIndex: 0,
        onsetBeatInMeasure: note.onset,
        durationBeats: 1,
        pitch: { step: note.step, alter: 0, octave: note.octave },
      }) as NoteHandle,
  );
  return { score: parseScore(serializeDocument(doc)), handles };
}

describe("chordForHandle", () => {
  test("resolves a note to its onset group", () => {
    const { score, handles } = scoreWithNotes([
      { onset: 0, step: "C", octave: 5 },
      { onset: 1, step: "E", octave: 5 },
    ]);
    const chord = chordForHandle(score, handles[1]);
    expect(chord).not.toBeNull();
    expect(chord?.measureIndex).toBe(0);
    expect(chord?.onsetBeat).toBe(1);
    expect(chord?.handles).toEqual([handles[1]]);
  });

  test("returns null for a handle that no longer resolves", () => {
    const { score } = scoreWithNotes([{ onset: 0, step: "C", octave: 5 }]);
    expect(
      chordForHandle(score, { measureIndex: 9, noteElementIndex: 9 }),
    ).toBeNull();
  });
});

describe("slots", () => {
  test("a blank document has one rest slot per empty measure", () => {
    const score = parseScore(serializeDocument(createBlankDocument()));
    const list = slots(score);
    // createBlankDocument defaults to 4 measures, each a full-measure rest.
    expect(list.length).toBe(4);
    expect(list.map((slot) => slot.onsetBeat)).toEqual([0, 4, 8, 12]);
    expect(list.every((slot) => slot.isRest)).toBe(true);
    expect(list.every((slot) => slot.handles.length === 0)).toBe(true);
  });

  test("enumerates rests between notes, in onset order", () => {
    // Quarter notes at beats 0 and 2 of measure 1 leave quarter rests at 1 and 3.
    const { score } = scoreWithNotes([
      { onset: 0, step: "C", octave: 5 },
      { onset: 2, step: "G", octave: 5 },
    ]);
    const firstMeasure = slots(score).filter((slot) => slot.measureIndex === 0);
    expect(
      firstMeasure.map((slot) => ({ beat: slot.onsetBeat, rest: slot.isRest })),
    ).toEqual([
      { beat: 0, rest: false },
      { beat: 1, rest: true },
      { beat: 2, rest: false },
      { beat: 3, rest: true },
    ]);
  });
});

describe("slotAt / slotAtBeat", () => {
  test("slotAtBeat resolves a rest position between notes", () => {
    const { score } = scoreWithNotes([
      { onset: 0, step: "C", octave: 5 },
      { onset: 2, step: "G", octave: 5 },
    ]);
    const slot = slotAtBeat(score, 1);
    expect(slot?.isRest).toBe(true);
    expect(slot?.onsetBeat).toBe(1);
  });

  test("slotAt resolves a slot by its position", () => {
    const { score } = scoreWithNotes([{ onset: 0, step: "C", octave: 5 }]);
    expect(slotAt(score, 0, 0)?.isRest).toBe(false);
    expect(slotAt(score, 0, 1)?.isRest).toBe(true);
    expect(slotAt(score, 0, 0.5)).toBeNull();
  });
});

describe("pitchForHandle", () => {
  test("reads the pitch a handle points at", () => {
    const { score, handles } = scoreWithNotes([
      { onset: 0, step: "F", octave: 4 },
    ]);
    expect(pitchForHandle(score, handles[0])).toEqual({
      step: "F",
      alter: 0,
      octave: 4,
    });
  });
});

describe("stepPitch", () => {
  test("steps up and down the diatonic scale, crossing octaves", () => {
    expect(stepPitch({ step: "C", alter: 0, octave: 5 }, 1)).toEqual({
      step: "D",
      alter: 0,
      octave: 5,
    });
    expect(stepPitch({ step: "B", alter: 0, octave: 4 }, 1)).toEqual({
      step: "C",
      alter: 0,
      octave: 5,
    });
    expect(stepPitch({ step: "C", alter: 0, octave: 5 }, -1)).toEqual({
      step: "B",
      alter: 0,
      octave: 4,
    });
    // A sharp note loses its accidental (the editor's no-accidental scope).
    expect(stepPitch({ step: "F", alter: 1, octave: 5 }, 1)).toEqual({
      step: "G",
      alter: 0,
      octave: 5,
    });
  });
});
