import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  addNote,
  addNoteToChord,
  createBlankDocument,
  insertMeasure,
  isEditableDocument,
  moveNote,
  type NoteHandle,
  parseDocument,
  removeNote,
  removeNotes,
  serializeDocument,
  setAccidental,
  setNoteDuration,
} from "./dom-edit";
import {
  type ChordGroup,
  isRest,
  type ParsedScore,
  parseScore,
} from "./sheet-music/index";

function reparse(doc: Document): ParsedScore {
  return parseScore(serializeDocument(doc));
}

// Flatten a score's chords with their measure index and absolute onset beat.
function chords(
  score: ParsedScore,
): Array<{ measureIndex: number; onsetBeat: number; chord: ChordGroup }> {
  const result: Array<{
    measureIndex: number;
    onsetBeat: number;
    chord: ChordGroup;
  }> = [];
  score.parts[0].measures.forEach((measure, measureIndex) => {
    let onsetBeat = 0;
    const divisions = measure.divisions || 4;
    for (const event of measure.events) {
      if (!isRest(event)) {
        result.push({ measureIndex, onsetBeat, chord: event });
      }
      onsetBeat += event.duration / divisions;
    }
  });
  return result;
}

describe("createBlankDocument", () => {
  test("produces a parseable empty score of the requested size", () => {
    const score = reparse(createBlankDocument({ measureCount: 3 }));
    expect(score.parts.length).toBe(1);
    expect(score.parts[0].measures.length).toBe(3);
    expect(score.numMeasures).toBe(3);
    // Every measure is a single full-measure rest.
    for (const measure of score.parts[0].measures) {
      expect(measure.events.length).toBe(1);
      expect(isRest(measure.events[0])).toBe(true);
    }
    expect(score.parts[0].timeSig).toEqual({ beats: 4, beatType: 4 });
    expect(score.parts[0].clef).toEqual({ sign: "G", line: 2 });
  });
});

describe("addNote", () => {
  test("inserts a note at the snapped measure/onset/pitch/duration", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    expect(handle).not.toBeNull();

    const score = reparse(doc);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(0);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.notes[0].pitch).toEqual({
      step: "C",
      alter: 0,
      octave: 5,
    });
  });

  test("fits the duration to the gap before an existing note", () => {
    const doc = createBlankDocument();
    // A quarter at beat 1, then a whole note requested at beat 0 — it must
    // shrink to a quarter so it does not overlap.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 4,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.map((p) => p.onsetBeat)).toEqual([0, 1]);
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.notes[0].pitch.step).toBe("C");
  });
});

describe("moveNote", () => {
  test("pitch-only change keeps the onset", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const moved = moveNote(doc, handle, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      pitch: { step: "G", alter: 0, octave: 5 },
    });
    expect(moved).not.toBeNull();
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.notes[0].pitch.step).toBe("G");
  });

  test("onset change relocates the note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    moveNote(doc, handle, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(2);
  });

  test("can move a note into another measure", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    moveNote(doc, handle, {
      measureIndex: 1,
      onsetBeatInMeasure: 1,
      pitch: { step: "D", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(1);
    expect(placed[0].onsetBeat).toBe(1);
    expect(placed[0].chord.notes[0].pitch.step).toBe("D");
  });
});

describe("removeNote", () => {
  test("turns the note's span back into rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    removeNote(doc, handle);
    const score = reparse(doc);
    expect(chords(score).length).toBe(0);
    expect(score.parts[0].measures[0].events.every(isRest)).toBe(true);
  });
});

describe("removeNotes", () => {
  test("removes several notes from one measure in a single rebuild", () => {
    const doc = createBlankDocument();
    const a = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const b = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    }) as NoteHandle;
    const c = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 5 },
    }) as NoteHandle;
    // Removing the first and last (by their original handles, resolved up front)
    // leaves only the middle note — the index shift of sequential removals would
    // otherwise drop the wrong elements.
    removeNotes(doc, [a, c]);
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(1);
    expect(placed[0].chord.notes[0].pitch.step).toBe("E");
    // Sanity: `b` still resolves to the surviving note.
    expect(b.measureIndex).toBe(0);
  });

  test("ignores handles that do not resolve", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    removeNotes(doc, [{ measureIndex: 9, noteElementIndex: 9 }]);
    // The real note is untouched.
    expect(chords(reparse(doc)).length).toBe(1);
    removeNotes(doc, [handle]);
    expect(chords(reparse(doc)).length).toBe(0);
  });
});

describe("fidelity", () => {
  // A two-note measure where the first note carries an articulation and a lyric
  // (neither modelled by the editor). Moving the *second* note must leave the
  // first note's expression elements byte-for-byte intact.
  const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
        <lyric><text>la</text></lyric>
        <notations><articulations><staccato/></articulations></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

  test("untouched note's expression elements survive a move of another note", () => {
    const doc = parseDocument(FIXTURE);
    // The E note is the 2nd <note> element in measure 0.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 1 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 2,
        pitch: { step: "F", alter: 0, octave: 5 },
      },
    );
    const serialized = serializeDocument(doc);
    // The first note's articulation and lyric are still present and intact.
    expect(serialized).toContain("<staccato");
    expect(serialized).toContain("<lyric><text>la</text></lyric>");
    // And it still parses as a staccato C5.
    const score = parseScore(serialized);
    const firstChord = chords(score)[0].chord;
    expect(firstChord.notes[0].pitch.step).toBe("C");
    expect(firstChord.notes[0].staccato).toBe(true);
  });
});

describe("round-trip", () => {
  // A real-world export: the Mozart "Rondo alla Turca" clip (MuseScore 2.2.1,
  // public domain), the same fixture the sibling piano-practice renderer tests
  // use. It carries a `<!DOCTYPE>`, the XML declaration, `identification` /
  // `encoding` / `source`, `defaults`, multi-line `credit`s, and a grand-staff
  // piano part with voices, `<backup>`, chords, grace notes, ties, and beams —
  // none of which the editor models, so all of it must survive a parse →
  // serialize round-trip by construction.
  const RONDO = readFileSync(
    fileURLToPath(
      new URL("./__fixtures__/rondo-alla-turca-clip.musicxml", import.meta.url),
    ),
    "utf8",
  );

  test("preserves the declaration, DOCTYPE, and all metadata/headers", () => {
    const serialized = serializeDocument(parseDocument(RONDO));

    // Declaration + DOCTYPE both present (the DOCTYPE was previously dropped).
    expect(serialized.startsWith("<?xml")).toBe(true);
    expect(serialized).toContain("<!DOCTYPE");

    // Metadata / headers the editor never models survive verbatim.
    expect(serialized).toContain("<software>MuseScore 2.2.1</software>");
    expect(serialized).toContain("<encoding-date>2018-05-10</encoding-date>");
    expect(serialized).toContain(
      "<source>http://musescore.com/classicman/scores/49143</source>",
    );
    expect(serialized).toContain("<part-name>Piano</part-name>");
    expect(serialized).toContain("<millimeters>7.05556</millimeters>");
    // Credits (title, work, composer) round-trip including their text.
    expect(serialized).toContain("Rondo alla Turca");
    expect(serialized).toContain("Wolfgang Amadeus Mozart");

    // And it re-parses without error.
    expect(() => parseScore(serialized)).not.toThrow();
  });

  test("editing one note leaves untouched measures byte-for-byte intact", () => {
    const doc = parseDocument(RONDO);
    // Serialize once before any edit. Both serializations go through the same
    // serializer, so any whitespace normalization is identical on each side and
    // the only difference must be the edited measure itself.
    const before = serializeDocument(doc);
    const identificationBefore = sliceTag(before, "identification");
    const measure5Before = sliceMeasure(before, 5);

    // Remove the first note of the pickup measure (measure index 0) — a single,
    // localized edit. dom-edit only rewrites that one measure.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const after = serializeDocument(doc);

    // Header metadata and an unrelated later measure are reused verbatim.
    expect(sliceTag(after, "identification")).toBe(identificationBefore);
    expect(sliceMeasure(after, 5)).toBe(measure5Before);
    // The edit did land somewhere: the whole document is not byte-identical.
    expect(after).not.toBe(before);
  });
});

describe("addNoteToChord", () => {
  test("stacks a chord member at the same beat, default a third above", () => {
    const doc = createBlankDocument();
    const base = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const added = addNoteToChord(doc, base);
    expect(added).not.toBeNull();

    const placed = chords(reparse(doc));
    // Still one beat (one chord) at onset 0…
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    // …now with two stacked notes, ordered low-to-high (C5 then a third up, E5).
    const pitches = placed[0].chord.notes.map((n) => n.pitch);
    expect(pitches).toEqual([
      { step: "C", alter: 0, octave: 5 },
      { step: "E", alter: 0, octave: 5 },
    ]);
    // The second member carries the <chord/> flag; the first does not.
    expect(placed[0].chord.notes[1].isChordMember).toBe(true);
    expect(placed[0].chord.notes[0].isChordMember).toBe(false);
  });

  test("honors an explicit pitch and round-trips a three-note chord", () => {
    const doc = createBlankDocument();
    const base = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNoteToChord(doc, base, { step: "E", alter: 0, octave: 5 });
    addNoteToChord(doc, base, { step: "G", alter: 0, octave: 5 });

    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].chord.notes.map((n) => n.pitch.step)).toEqual([
      "C",
      "E",
      "G",
    ]);
  });
});

describe("setAccidental", () => {
  test("applies, then clears, a sharp on a note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "F", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setAccidental(doc, handle, 1)).toBe(true);
    let note = chords(reparse(doc))[0].chord.notes[0];
    expect(note.pitch.alter).toBe(1);
    expect(note.accidental).toBe("sharp");

    // Natural drops the <alter> back to a plain F (no printed accidental in C).
    expect(setAccidental(doc, handle, 0)).toBe(true);
    note = chords(reparse(doc))[0].chord.notes[0];
    expect(note.pitch.alter).toBe(0);
    expect(note.accidental).toBe("none");
  });
});

describe("setNoteDuration", () => {
  test("grows a note, consuming the trailing rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setNoteDuration(doc, handle, 2)).toBe(true);
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.type).toBe("half");
    expect(placed[0].chord.notes[0].pitch.step).toBe("C");
  });

  test("shrinks a note, refilling the gap with a rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 4,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setNoteDuration(doc, handle, 1)).toBe(true);
    const score = reparse(doc);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].chord.type).toBe("quarter");
    // The freed three beats are rebalanced into rests.
    const events = score.parts[0].measures[0].events;
    expect(events.length).toBe(2);
    expect(isRest(events[1])).toBe(true);
  });

  test("clamps growth to the gap before the next note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1.5,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });

    expect(setNoteDuration(doc, handle, 4)).toBe(true);
    const placed = chords(reparse(doc));
    // Clamped to the 1.5-beat gap before the next note: a dotted quarter.
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.dot).toBe(true);
    expect(placed[1].onsetBeat).toBe(1.5);
  });

  test("resizes every member of a chord together", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNoteToChord(doc, handle, { step: "E", alter: 0, octave: 5 });

    expect(setNoteDuration(doc, handle, 2)).toBe(true);
    const chord = chords(reparse(doc))[0].chord;
    expect(chord.type).toBe("half");
    expect(chord.notes.map((n) => n.pitch.step).sort()).toEqual(["C", "E"]);
  });
});

describe("insertMeasure", () => {
  test("appends a blank measure and renumbers sequentially", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const newIndex = insertMeasure(doc);
    expect(newIndex).toBe(2);

    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(3);
    expect(score.parts[0].measures.map((m) => m.number)).toEqual([1, 2, 3]);
    // The new (last) measure is a single full-measure rest.
    const last = score.parts[0].measures[2];
    expect(last.events.length).toBe(1);
    expect(isRest(last.events[0])).toBe(true);
  });

  test("inserts in the middle and shifts later measures down", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    // A note in measure 2 (index 1) so we can prove it moved to measure 3.
    addNote(doc, {
      measureIndex: 1,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    insertMeasure(doc, 0); // after measure index 0

    const placed = chords(reparse(doc));
    expect(reparse(doc).parts[0].measures.length).toBe(3);
    // The note that was in measure index 1 is now in measure index 2.
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(2);
  });
});

describe("isEditableDocument", () => {
  test("a blank single-staff document is editable", () => {
    expect(isEditableDocument(createBlankDocument())).toBe(true);
  });

  test("a single-staff file with notes is editable", () => {
    const doc = createBlankDocument();
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    expect(isEditableDocument(doc)).toBe(true);
  });

  test("a simple grand-staff part (one backup per measure) is editable", () => {
    const rondo = readFileSync(
      fileURLToPath(
        new URL(
          "./__fixtures__/rondo-alla-turca-clip.musicxml",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(isEditableDocument(parseDocument(rondo))).toBe(true);
  });

  test("a multi-voice grand-staff part (multiple backups per measure) is editable", () => {
    // Two voices per staff = 3 backups per measure; writeMeasure handles this now.
    const multiVoice = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <staves>2</staves>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>6</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;
    expect(isEditableDocument(parseDocument(multiVoice))).toBe(true);
  });

  test("a multi-part score is view-only", () => {
    const twoParts = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>One</part-name></score-part>
    <score-part id="P2"><part-name>Two</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"></measure></part>
  <part id="P2"><measure number="1"></measure></part>
</score-partwise>`;
    expect(isEditableDocument(parseDocument(twoParts))).toBe(false);
  });
});

// A minimal two-staff (grand staff) fixture: treble + bass, one voice each,
// one backup per measure — the "simple grand staff" shape the editor supports.
const GRAND_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("grand-staff editing", () => {
  function grandStaffChords(
    score: ReturnType<typeof parseScore>,
    partIndex: number,
  ): Array<{ onsetBeat: number; notes: Array<{ step: string }> }> {
    const result: Array<{ onsetBeat: number; notes: Array<{ step: string }> }> =
      [];
    const part = score.parts[partIndex];
    if (!part) {
      return result;
    }
    let beat = 0;
    const divisions = part.measures[0]?.divisions || 4;
    for (const event of part.measures[0]?.events ?? []) {
      if (!isRest(event)) {
        result.push({
          onsetBeat: beat,
          notes: (event as ChordGroup).notes.map((n) => ({
            step: n.pitch.step,
          })),
        });
      }
      beat += event.duration / divisions;
    }
    return result;
  }

  test("removeNote on staff 1 leaves staff 2 intact", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // E5 is note element index 0 (staff 1). Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    // Treble staff (parts[0]) is all rests.
    expect(score.parts[0].measures[0].events.every(isRest)).toBe(true);
    // Bass staff (parts[1]) still has G2.
    const bassChords = grandStaffChords(score, 1);
    expect(bassChords.length).toBe(1);
    expect(bassChords[0].notes[0].step).toBe("G");
  });

  test("removeNote on staff 2 leaves staff 1 intact", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // G2 is note element index 1 (staff 2). Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 1 });
    const score = parseScore(serializeDocument(doc));
    // Bass staff (parts[1]) is all rests.
    expect(score.parts[1].measures[0].events.every(isRest)).toBe(true);
    // Treble staff (parts[0]) still has E5.
    const trebleChords = grandStaffChords(score, 0);
    expect(trebleChords.length).toBe(1);
    expect(trebleChords[0].notes[0].step).toBe("E");
  });

  test("notes have source provenance for both staves", () => {
    const score = parseScore(GRAND_STAFF_XML);
    // Grand staff parses into two parts.
    expect(score.parts.length).toBe(2);
    const trebleNote = (score.parts[0].measures[0].events[0] as ChordGroup)
      .notes[0];
    const bassNote = (score.parts[1].measures[0].events[0] as ChordGroup)
      .notes[0];
    // Both staves carry source provenance so the editor can select/edit them.
    expect(trebleNote.source).toEqual({ measureIndex: 0, noteElementIndex: 0 });
    expect(bassNote.source).toEqual({ measureIndex: 0, noteElementIndex: 1 });
  });

  test("addNote inserts into the correct staff", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // Add a note to the bass staff at beat 1.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 3 },
      staff: 2,
    });
    const score = parseScore(serializeDocument(doc));
    // Treble (parts[0]) is unchanged — still one note.
    const trebleChords = grandStaffChords(score, 0);
    expect(trebleChords.length).toBe(1);
    expect(trebleChords[0].notes[0].step).toBe("E");
    // Bass (parts[1]) now has two notes: G2 at beat 0 and C3 at beat 1.
    const bassChords = grandStaffChords(score, 1);
    expect(bassChords.length).toBe(2);
    expect(bassChords[0].notes[0].step).toBe("G");
    expect(bassChords[1].notes[0].step).toBe("C");
  });

  test("insertMeasure creates a valid grand-staff blank measure", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    insertMeasure(doc);
    const score = parseScore(serializeDocument(doc));
    expect(score.parts[0].measures.length).toBe(2);
    expect(score.parts[1].measures.length).toBe(2);
    // The new measure is all rests in both staves.
    expect(score.parts[0].measures[1].events.every(isRest)).toBe(true);
    expect(score.parts[1].measures[1].events.every(isRest)).toBe(true);
  });
});

// A grand-staff fixture with two voices on staff 1: voice 1 has a half note D5,
// voice 2 has two quarter notes B4+G4 over the same span. Staff 2 has one voice.
const MULTI_VOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>half</type><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><voice>1</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><voice>2</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><voice>2</voice><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration><type>half</type><voice>5</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("multi-voice grand-staff editing", () => {
  test("removeNote on voice-1 staff-1 leaves voice-2 staff-1 and staff-2 intact", () => {
    const doc = parseDocument(MULTI_VOICE_XML);
    // D5 (voice 1) is note element index 0. Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    // Treble (parts[0]): voice 1 first slot becomes rest, but C5 and D5 remain.
    const treble = score.parts[0].measures[0].events;
    expect(
      treble.some(
        (e) =>
          !isRest(e) &&
          (e as ChordGroup).notes.some((n) => n.pitch.step === "C"),
      ),
    ).toBe(true);
    // Voice-2 notes B4 and G4 survive.
    const bass1 = score.parts[0].measures[0].events;
    const allSteps = bass1.flatMap((e) =>
      isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
    );
    expect(allSteps).toContain("B");
    expect(allSteps).toContain("G");
    // Staff 2 (parts[1]): G3 still present.
    const bassChords = score.parts[1].measures[0].events.filter(
      (e) => !isRest(e),
    ) as ChordGroup[];
    expect(
      bassChords.some((c) => c.notes.some((n) => n.pitch.step === "G")),
    ).toBe(true);
  });

  test("addNote on staff 2 of a multi-voice score leaves staff-1 voices intact", () => {
    const doc = parseDocument(MULTI_VOICE_XML);
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 3 },
      staff: 2,
    });
    const score = parseScore(serializeDocument(doc));
    // Staff 1 treble voices: D5 (voice 1), B4/G4 (voice 2) all survive.
    const treble = score.parts[0].measures[0].events;
    const trebleSteps = treble.flatMap((e) =>
      isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
    );
    expect(trebleSteps).toContain("D");
    expect(trebleSteps).toContain("B");
    expect(trebleSteps).toContain("G");
    // Staff 2: now has G3 and C3.
    const bassChords = score.parts[1].measures[0].events.filter(
      (e) => !isRest(e),
    ) as ChordGroup[];
    const bassSteps = bassChords.flatMap((c) =>
      c.notes.map((n) => n.pitch.step),
    );
    expect(bassSteps).toContain("G");
    expect(bassSteps).toContain("C");
  });
});

// The total length, in quarter-note beats, of a part's measure `m` — the sum of
// its event durations. Used to assert an edit preserves a bar's length.
function measureBeats(
  score: ParsedScore,
  partIndex: number,
  m: number,
): number {
  const measure = score.parts[partIndex]?.measures[m];
  if (!measure) {
    return 0;
  }
  const divisions = measure.divisions || 4;
  return measure.events.reduce((t, e) => t + e.duration / divisions, 0);
}

// A flat list of "step+octave" strings for the chord at event index over a
// part's measure 0, top-first (descending pitch) like the inspector.
function chordPitches(
  score: ParsedScore,
  partIndex: number,
  onsetBeat: number,
): string[] {
  const stepOrder: Record<string, number> = {
    C: 0,
    D: 1,
    E: 2,
    F: 3,
    G: 4,
    A: 5,
    B: 6,
  };
  const diatonic = (p: { step: string; octave: number }) =>
    p.octave * 7 + (stepOrder[p.step] ?? 0);
  let beat = 0;
  const measure = score.parts[partIndex]?.measures[0];
  const divisions = measure?.divisions || 4;
  for (const event of measure?.events ?? []) {
    if (!isRest(event) && Math.abs(beat - onsetBeat) < 1e-6) {
      return [...(event as ChordGroup).notes]
        .sort((a, b) => diatonic(b.pitch) - diatonic(a.pitch))
        .map((n) => `${n.pitch.step || "<EMPTY>"}${n.pitch.octave}`);
    }
    beat += event.duration / divisions;
  }
  return [];
}

// These guard the family of corruptions seen when stepping a chord member in an
// imported grand-staff score (Chrono Trigger fixture): the bar restructured, the
// other staff shifted, and a phantom "<step>-less" note appeared. The triggers —
// distinct from #30's single-staff/single-note coverage — are bars whose true
// length differs from the time signature, and chords whose members have unequal
// durations.
describe("irregular bars and mismatched-duration chords (regression)", () => {
  // 4/4 nominal (16 divisions) but the bar actually holds 5 quarters (20) in both
  // staves — an over-full bar, as real engraved scores contain. The treble has a
  // chord C5+A4 at beat 1; the bass is independent.
  const OVERFULL = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <backup><duration>20</duration></backup>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
    <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
  </measure></part></score-partwise>`;

  test("stepping a treble chord member keeps both staves' length and the bass intact", () => {
    const doc = parseDocument(OVERFULL);
    // C5 is note element index 0 (staff 1, the chord's first member).
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 0 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 0,
        pitch: { step: "D", alter: 0, octave: 5 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // Both staves keep their true 5-beat length (not truncated to the 4/4 nominal).
    expect(measureBeats(score, 0, 0)).toBe(5);
    expect(measureBeats(score, 1, 0)).toBe(5);
    // The stepped chord is exactly D5 over A4 — no phantom, no duplicate.
    expect(chordPitches(score, 0, 0)).toEqual(["D5", "A4"]);
    // The bass is untouched: C3, G2, C3 at beats 0, 2, 4.
    expect(chordPitches(score, 1, 0)).toEqual(["C3"]);
    expect(chordPitches(score, 1, 2)).toEqual(["G2"]);
    expect(chordPitches(score, 1, 4)).toEqual(["C3"]);
  });

  // A grand-staff bar (the Chrono Trigger shape) whose treble beat-2 chord stacks
  // members of unequal length: C5/A4 quarters with a lower E4 *eighth*. Stepping
  // the unrelated beat-1 note must not let the rewrite make the short, low E4 the
  // cursor-advancing (plain) note — which would under-advance the time cursor and
  // swallow the rest of the bar (and desync the bass).
  const MISMATCHED = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef></attributes>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>half</type><staff>1</staff></note>
    <backup><duration>16</duration></backup>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><type>whole</type><staff>2</staff></note>
  </measure></part></score-partwise>`;

  test("stepping near a mismatched-duration chord keeps the bar's length", () => {
    const doc = parseDocument(MISMATCHED);
    // Step the beat-1 G4 (treble index 0) up a step; the beat-2 chord is untouched.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 0 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 0,
        pitch: { step: "A", alter: 0, octave: 4 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // The treble is still a full 4 beats — the short E4 didn't collapse it.
    expect(measureBeats(score, 0, 0)).toBe(4);
    // The bass whole note is untouched (no desync).
    expect(measureBeats(score, 1, 0)).toBe(4);
    expect(chordPitches(score, 1, 0)).toEqual(["C3"]);
    // The mismatched chord still sounds all three pitches at beat 1.
    expect(chordPitches(score, 0, 1)).toEqual(["C5", "A4", "E4"]);
    // The half note at beat 2 survives.
    expect(chordPitches(score, 0, 2)).toEqual(["D5"]);
  });
});

describe("grace notes survive edits", () => {
  // A single grace note (D5) ornaments the beat-2 chord E5+G5.
  const GRACE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><grace/><pitch><step>D</step><octave>5</octave></pitch><type>eighth</type></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><pitch><step>F</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
  </measure></part></score-partwise>`;

  test("stepping the grace's host chord keeps the grace and the bar", () => {
    const doc = parseDocument(GRACE);
    // G5 (top of the beat-2 chord) is note element index 3; step it up to A5.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 3 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 1,
        pitch: { step: "A", alter: 0, octave: 5 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // Bar length preserved (no collapse from folding the grace into the chord).
    expect(measureBeats(score, 0, 0)).toBe(4);
    // The chord stepped to E5 + A5 (no phantom, no swallowed notes).
    expect(chordPitches(score, 0, 1)).toEqual(["A5", "E5"]);
    // The grace note D5 still precedes the beat-2 chord.
    const beat2 = score.parts[0].measures[0].events.find(
      (e) => !isRest(e) && (e as ChordGroup).gracesBefore !== undefined,
    ) as ChordGroup | undefined;
    expect(beat2?.gracesBefore?.[0].notes[0].pitch.step).toBe("D");
    // No note lost its <step>.
    expect(serializeDocument(doc)).not.toContain("<step></step>");
  });
});

describe("non-quarter divisions", () => {
  // divisions=8 (quarter = 8): a quarter note must still be typed "quarter", and
  // a gap must fill with correctly-scaled rests — not the 4-per-quarter the
  // editor's blank document uses.
  const DIV8 = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>8</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><type>quarter</type></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><type>quarter</type></note>
    <note><rest/><duration>16</duration><type>half</type></note>
  </measure></part></score-partwise>`;

  test("addNote types a quarter as a quarter (not a half)", () => {
    const doc = parseDocument(DIV8);
    // Add a quarter (durationBeats 1 = 8 divisions) into the rest at beat 3.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 5 },
    });
    const score = parseScore(serializeDocument(doc));
    const placed = chords(score);
    const added = placed.find((p) => p.onsetBeat === 2);
    expect(added?.chord.type).toBe("quarter");
    // The bar still totals four quarter beats.
    expect(measureBeats(score, 0, 0)).toBe(4);
  });

  test("removing a note fills the gap with a correctly-typed rest", () => {
    const doc = parseDocument(DIV8);
    // Remove the beat-1 C5 (index 0); the gap becomes a quarter rest, not a half.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    const firstRest = score.parts[0].measures[0].events[0];
    expect(isRest(firstRest)).toBe(true);
    expect((firstRest as { type: string }).type).toBe("quarter");
    expect(measureBeats(score, 0, 0)).toBe(4);
  });
});

// Extract the enclosing `<tag>…</tag>` substring (first occurrence).
function sliceTag(xml: string, tag: string): string {
  const open = xml.indexOf(`<${tag}`);
  const close = xml.indexOf(`</${tag}>`, open) + `</${tag}>`.length;
  return xml.slice(open, close);
}

// Extract the `<measure number="N" …>…</measure>` substring.
function sliceMeasure(xml: string, number: number): string {
  const open = xml.indexOf(`<measure number="${number}"`);
  const close = xml.indexOf("</measure>", open) + "</measure>".length;
  return xml.slice(open, close);
}
