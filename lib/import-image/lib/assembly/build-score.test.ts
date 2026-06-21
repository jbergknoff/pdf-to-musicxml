import { describe, expect, it } from "bun:test";
import type {
  NoteEvent,
  ScoreAttributes,
  ScoreSystem,
  Transcription,
} from "../types";
import { buildScore } from "./musicxml-builder";

function note(
  pitch: string,
  measureIndex = 0,
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch,
    duration: "quarter",
    dotted: false,
    accidental: "natural",
    measureIndex,
    chord: false,
    ...extra,
  };
}

function staff(
  notes: NoteEvent[],
  attributes: ScoreAttributes = {},
): Transcription {
  return { notes, measureCount: 0, rawRhythm: [], attributes };
}

function system(...staves: Transcription[]): ScoreSystem {
  return { staves };
}

const TREBLE: ScoreAttributes = {
  clef: { sign: "G", line: 2 },
  time: { beats: 4, beatType: 4 },
};
const BASS: ScoreAttributes = { clef: { sign: "F", line: 4 } };

describe("buildScore — single staff", () => {
  it("matches the single-staff format (no <staves>/<staff>/<backup>)", () => {
    const xml = buildScore([system(staff([note("C4")], TREBLE))]);
    expect(xml).not.toContain("<staves>");
    expect(xml).not.toContain("<staff>");
    expect(xml).not.toContain("<backup>");
    expect(xml).toContain("<step>C</step>");
  });

  it("concatenates single-staff systems sequentially in time", () => {
    const xml = buildScore([
      system(staff([note("C4", 0)], TREBLE)),
      system(staff([note("D4", 0)], TREBLE)),
    ]);
    // The second system's measure 0 becomes measure 2 of the part.
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure number="2"');
    const firstNote = xml.indexOf("<step>C</step>");
    const secondNote = xml.indexOf("<step>D</step>");
    expect(firstNote).toBeLessThan(secondNote);
  });

  it("throws rather than guess when the staff's clef was not recovered", () => {
    expect(() => buildScore([system(staff([note("C4")]))])).toThrow(/clef/i);
  });
});

describe("buildScore — grand staff", () => {
  it("emits one part with two staves, a clef per staff", () => {
    const xml = buildScore([
      system(staff([note("C5")], TREBLE), staff([note("C3")], BASS)),
    ]);
    expect(xml).toContain("<staves>2</staves>");
    expect(xml).toContain(
      '<clef number="1"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="2"><sign>F</sign><line>4</line></clef>',
    );
  });

  it("tags notes with their staff and voice and backs up between staves", () => {
    const xml = buildScore([
      system(staff([note("C5")], TREBLE), staff([note("C3")], BASS)),
    ]);
    expect(xml).toContain("<staff>1</staff>");
    expect(xml).toContain("<staff>2</staff>");
    expect(xml).toContain("<voice>1</voice>");
    expect(xml).toContain("<voice>2</voice>");
    // Backup rewinds by the treble's written duration (one quarter = 4).
    expect(xml).toContain("<backup>\n  <duration>4</duration>\n</backup>");
    // The bass note follows the backup.
    const backupIndex = xml.indexOf("<backup>");
    const bassNote = xml.indexOf("<octave>3</octave>");
    expect(backupIndex).toBeLessThan(bassNote);
  });

  it("fills an empty staff in a non-empty measure with a measure rest", () => {
    // Treble plays measures 0 and 1; bass plays only measure 0.
    const xml = buildScore([
      system(
        staff([note("C5", 0), note("D5", 1)], TREBLE),
        staff([note("C3", 0)], BASS),
      ),
    ]);
    // Measure 2 (index 1): bass staff gets a whole-measure rest on staff 2.
    const secondMeasure = xml.slice(xml.indexOf('measure number="2"'));
    expect(secondMeasure).toContain('<rest measure="yes"/>');
    expect(secondMeasure).toContain("<staff>2</staff>");
  });

  it("runs grand-staff systems sequentially across the part", () => {
    const xml = buildScore([
      system(staff([note("C5", 0)], TREBLE), staff([note("C3", 0)], BASS)),
      system(staff([note("E5", 0)], TREBLE), staff([note("E3", 0)], BASS)),
    ]);
    // Two systems of one measure each → two measures total.
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure number="2"');
    expect(xml).not.toContain('measure number="3"');
  });

  it("derives the shared meter from the top staff for backups", () => {
    // 3/4: an empty bass measure rest spans three quarters = 12 divisions.
    const treble: ScoreAttributes = {
      clef: { sign: "G", line: 2 },
      time: { beats: 3, beatType: 4 },
    };
    const xml = buildScore([
      system(staff([], treble), staff([], BASS)),
    ]);
    expect(xml).toContain("<beats>3</beats>");
    expect(xml).toContain("<duration>12</duration>");
  });
});

describe("buildScore — three-stave piano", () => {
  it("emits three staves with each recovered clef", () => {
    const xml = buildScore([
      system(
        staff([note("E5")], TREBLE),
        staff([note("C4")], TREBLE),
        staff([note("C3")], BASS),
      ),
    ]);
    expect(xml).toContain("<staves>3</staves>");
    expect(xml).toContain(
      '<clef number="1"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="2"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="3"><sign>F</sign><line>4</line></clef>',
    );
  });

  it("throws rather than guess when a staff's clef was not recovered", () => {
    // The middle staff recovered no clef — refuse to build instead of defaulting.
    expect(() =>
      buildScore([
        system(staff([note("E5")], TREBLE), staff([note("C4")]), staff([note("C3")], BASS)),
      ]),
    ).toThrow(/clef/i);
  });
});
