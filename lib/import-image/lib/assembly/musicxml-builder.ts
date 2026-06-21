/**
 * Assembles a minimal, valid MusicXML 3.1 document from a flat list of
 * NoteEvents: one part, one staff, one voice. The opening clef, key, and time
 * signature come from the optional `BuildOptions.attributes` (recovered per
 * staff by `decode-attributes.ts`), each defaulting to treble / C major / 4/4
 * when TrOMR did not emit the symbol.
 *
 * Durations are expressed in divisions where one quarter note = 4 divisions,
 * giving clean integer values for all standard subdivisions down to 32nd notes.
 */
import type { NoteEvent, ScoreAttributes, ScoreSystem } from "../types";
import { type BeamElement, computeBeams } from "./beams";
import { combinePages } from "./combine-pages";
import { DIVISIONS, DURATION_DIVISIONS, noteDivisions } from "./durations";

const MUSICXML_TYPE: Record<NoteEvent["duration"], string> = {
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  sixteenth: "16th",
  thirty_second: "32nd",
};

const STEP_FROM_PITCH: Record<string, string> = {
  C: "C",
  D: "D",
  E: "E",
  F: "F",
  G: "G",
  A: "A",
  B: "B",
};

const ACCIDENTAL_XML: Record<string, string | undefined> = {
  sharp: "sharp",
  flat: "flat",
  natural: "natural",
  double_sharp: "double-sharp",
  double_flat: "double-flat",
};

const ALTER_XML: Record<string, string | undefined> = {
  sharp: "1",
  flat: "-1",
  double_sharp: "2",
  double_flat: "-2",
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function beamLines(beams: BeamElement[]): string[] {
  return beams.map(
    (beam) => `  <beam number="${beam.number}">${beam.type}</beam>`,
  );
}

/**
 * One `<note>`. When `staffNumber` is given (multi-staff parts), the note also
 * carries `<voice>` and `<staff>`; without it the output is the single-staff,
 * single-voice form. Beams render only at the chosen level(s).
 */
function noteXml(
  note: NoteEvent,
  beams: BeamElement[],
  staffNumber?: number,
): string {
  const divisions = DURATION_DIVISIONS[note.duration];
  const dottedDivisions = note.dotted ? Math.round(divisions * 1.5) : divisions;
  const type = MUSICXML_TYPE[note.duration];
  // One voice per staff keeps the two hands' rhythms independent.
  const voiceLine =
    staffNumber !== undefined ? `  <voice>${staffNumber}</voice>` : "";
  const staffLine =
    staffNumber !== undefined ? `  <staff>${staffNumber}</staff>` : "";

  if (note.pitch === "rest") {
    return [
      "<note>",
      note.chord ? "  <chord/>" : "",
      "  <rest/>",
      `  <duration>${dottedDivisions}</duration>`,
      voiceLine,
      `  <type>${type}</type>`,
      note.dotted ? "  <dot/>" : "",
      staffLine,
      "</note>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Pitch token format: "C4", "D#5" — but TrOMR encodes accidentals in the
  // lift token, not the pitch token (the pitch token is always diatonic).
  const step = note.pitch[0];
  const octave = note.pitch.slice(1);
  const alter =
    note.accidental !== null ? ALTER_XML[note.accidental] : undefined;
  const accidentalTag =
    note.accidental !== null && note.accidental !== "natural"
      ? `  <accidental>${ACCIDENTAL_XML[note.accidental] ?? ""}</accidental>`
      : "";

  return [
    "<note>",
    note.chord ? "  <chord/>" : "",
    "  <pitch>",
    `    <step>${escapeXml(STEP_FROM_PITCH[step] ?? step)}</step>`,
    alter !== undefined ? `    <alter>${alter}</alter>` : "",
    `    <octave>${escapeXml(octave)}</octave>`,
    "  </pitch>",
    `  <duration>${dottedDivisions}</duration>`,
    voiceLine,
    `  <type>${type}</type>`,
    note.dotted ? "  <dot/>" : "",
    accidentalTag,
    staffLine,
    ...beamLines(beams),
    "</note>",
  ]
    .filter(Boolean)
    .join("\n");
}

// Defaults used when TrOMR did not recover the corresponding attribute.
const DEFAULT_FIFTHS = 0; // C major / A minor
const DEFAULT_BEATS = 4;
const DEFAULT_BEAT_TYPE = 4;
const DEFAULT_CLEF = { sign: "G", line: 2 }; // treble

function attributesXml(attributes: ScoreAttributes): string {
  const fifths = attributes.keyFifths ?? DEFAULT_FIFTHS;
  const beats = attributes.time?.beats ?? DEFAULT_BEATS;
  const beatType = attributes.time?.beatType ?? DEFAULT_BEAT_TYPE;
  const clef = attributes.clef ?? DEFAULT_CLEF;
  return [
    "<attributes>",
    `  <divisions>${DIVISIONS}</divisions>`,
    `  <key><fifths>${fifths}</fifths></key>`,
    `  <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`,
    `  <clef><sign>${escapeXml(clef.sign)}</sign><line>${clef.line}</line></clef>`,
    "</attributes>",
  ].join("\n");
}

/**
 * A mid-measure clef/key/time change: a partial `<attributes>` carrying only the
 * fields that changed (no `<divisions>`, no defaults), emitted before the note it
 * takes effect on. Element order follows the MusicXML schema (key, time, clef).
 */
function attributeChangeXml(
  change: ScoreAttributes,
  staffNumber?: number,
): string {
  const lines = ["<attributes>"];
  if (change.keyFifths !== undefined) {
    lines.push(`  <key><fifths>${change.keyFifths}</fifths></key>`);
  }
  if (change.time !== undefined) {
    lines.push(
      `  <time><beats>${change.time.beats}</beats>` +
        `<beat-type>${change.time.beatType}</beat-type></time>`,
    );
  }
  if (change.clef !== undefined) {
    // A clef change targets a specific staff in a multi-staff part.
    const number = staffNumber !== undefined ? ` number="${staffNumber}"` : "";
    lines.push(
      `  <clef${number}><sign>${escapeXml(change.clef.sign)}</sign>` +
        `<line>${change.clef.line}</line></clef>`,
    );
  }
  lines.push("</attributes>");
  return lines.join("\n");
}

/** Indent a measure's children and wrap them in `<measure number="…">`. */
function wrapMeasure(measureNumber: number, children: string[]): string {
  const indent = children.map((line) => `    ${line}`).join("\n");
  return `  <measure number="${measureNumber}">\n${indent}\n  </measure>`;
}

function measureXml(
  notes: NoteEvent[],
  measureNumber: number,
  isFirstMeasure: boolean,
  attributes: ScoreAttributes,
  beats: number,
  beatType: number,
): string {
  const children: string[] = [];

  if (isFirstMeasure) {
    children.push(attributesXml(attributes));
  }

  // If the measure is empty, emit a whole-measure rest to keep MusicXML valid.
  if (notes.length === 0) {
    children.push(
      "<note>",
      '  <rest measure="yes"/>',
      "  <duration>16</duration>",
      "  <type>whole</type>",
      "</note>",
    );
  } else {
    const beams = computeBeams(notes, beats, beatType);
    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      // A mid-staff clef/key/time change takes effect before this note.
      if (note.attributeChange !== undefined) {
        children.push(attributeChangeXml(note.attributeChange));
      }
      children.push(noteXml(note, beams.get(index) ?? []));
    }
  }

  return wrapMeasure(measureNumber, children);
}

export interface BuildOptions {
  /** Opening clef/key/time for the part; each field defaults when omitted. */
  attributes?: ScoreAttributes;
  /** `<part-name>` for the single part. */
  partName?: string;
}

/**
 * Build a complete MusicXML 3.1 document from a flat list of note events.
 * Returns a UTF-8 XML string suitable for feeding to OSMD or writing to disk.
 */
export function buildMusicXML(
  notes: NoteEvent[],
  options: BuildOptions = {},
): string {
  const attributes = options.attributes ?? {};
  const partName = options.partName ?? "Music";
  // Group notes by measure. Use the maximum measureIndex rather than the last
  // note's: when notes are concatenated across staves (each staff numbering its
  // own measures from 0), an earlier staff can hold a higher measureIndex than
  // the final note, so the last note alone would undercount the measures.
  let maxMeasureIndex = 0;
  for (const note of notes) {
    if (note.measureIndex > maxMeasureIndex) {
      maxMeasureIndex = note.measureIndex;
    }
  }
  const measureCount = notes.length === 0 ? 1 : maxMeasureIndex + 1;
  const byMeasure: NoteEvent[][] = Array.from(
    { length: measureCount },
    () => [],
  );
  for (const note of notes) {
    byMeasure[note.measureIndex].push(note);
  }

  // Track the time signature in effect at each measure's start (for beam
  // grouping). It begins at the opening attributes and shifts when a note
  // carries a time change; mid-measure changes take effect from the next
  // measure for beaming purposes.
  let beats = attributes.time?.beats ?? DEFAULT_BEATS;
  let beatType = attributes.time?.beatType ?? DEFAULT_BEAT_TYPE;
  const measures = byMeasure.map((notesInMeasure, index) => {
    const xml = measureXml(
      notesInMeasure,
      index + 1,
      index === 0,
      attributes,
      beats,
      beatType,
    );
    for (const note of notesInMeasure) {
      if (note.attributeChange?.time !== undefined) {
        beats = note.attributeChange.time.beats;
        beatType = note.attributeChange.time.beatType;
      }
    }
    return xml;
  });

  return wrapDocument(partName, measures);
}

// ---------------------------------------------------------------------------
// Multi-staff (grand staff) assembly
// ---------------------------------------------------------------------------

/** Measures spanned by a staff's notes: one past the maximum measure index. */
function measureSpanOf(notes: NoteEvent[]): number {
  let maxIndex = -1;
  for (const note of notes) {
    if (note.measureIndex > maxIndex) {
      maxIndex = note.measureIndex;
    }
  }
  return maxIndex + 1;
}

/** A full measure's worth of divisions for the given meter. */
function measureLength(beats: number, beatType: number): number {
  return (beats * DIVISIONS * 4) / beatType;
}

/** Opening `<attributes>` for a multi-staff part: shared key/time, a clef per staff. */
function grandStaffAttributesXml(
  staffAttributes: (ScoreAttributes | undefined)[],
): string {
  const top = staffAttributes[0] ?? {};
  const fifths = top.keyFifths ?? DEFAULT_FIFTHS;
  const beats = top.time?.beats ?? DEFAULT_BEATS;
  const beatType = top.time?.beatType ?? DEFAULT_BEAT_TYPE;
  const lines = [
    "<attributes>",
    `  <divisions>${DIVISIONS}</divisions>`,
    `  <key><fifths>${fifths}</fifths></key>`,
    `  <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`,
    `  <staves>${staffAttributes.length}</staves>`,
  ];
  for (let staffIndex = 0; staffIndex < staffAttributes.length; staffIndex++) {
    // The clef is never guessed: if TrOMR did not recover it, refuse to build
    // rather than emit a plausible-but-wrong clef (see decode-attributes).
    const clef = staffAttributes[staffIndex]?.clef;
    if (clef === undefined) {
      throw new Error(
        `No clef was recognized for staff ${staffIndex + 1} of ` +
          `${staffAttributes.length}; refusing to guess. Inspect the [omr] ` +
          "TrOMR token logs in the console to see what was decoded.",
      );
    }
    lines.push(
      `  <clef number="${staffIndex + 1}"><sign>${escapeXml(clef.sign)}</sign>` +
        `<line>${clef.line}</line></clef>`,
    );
  }
  lines.push("</attributes>");
  return lines.join("\n");
}

/** `<backup>` to rewind the cursor (by the previous staff's written duration). */
function backupXml(duration: number): string {
  return `<backup>\n  <duration>${duration}</duration>\n</backup>`;
}

/** A whole-measure rest on a specific staff, spanning the measure's length. */
function staffMeasureRestXml(staffNumber: number, length: number): string {
  return [
    "<note>",
    '  <rest measure="yes"/>',
    `  <duration>${length}</duration>`,
    `  <voice>${staffNumber}</voice>`,
    "  <type>whole</type>",
    `  <staff>${staffNumber}</staff>`,
    "</note>",
  ].join("\n");
}

/** One measure of a multi-staff part: each staff's notes, separated by `<backup>`. */
function grandStaffMeasureXml(
  staffNotes: NoteEvent[][],
  measureNumber: number,
  openingAttributes: string | null,
  beats: number,
  beatType: number,
): string {
  const children: string[] = [];
  if (openingAttributes !== null) {
    children.push(openingAttributes);
  }
  const length = measureLength(beats, beatType);
  let previousDuration = 0;
  for (let staffIndex = 0; staffIndex < staffNotes.length; staffIndex++) {
    const notes = staffNotes[staffIndex];
    const staffNumber = staffIndex + 1;
    // Rewind to the measure start before laying down the next staff.
    if (staffIndex > 0) {
      children.push(backupXml(previousDuration));
    }
    if (notes.length === 0) {
      children.push(staffMeasureRestXml(staffNumber, length));
      previousDuration = length;
      continue;
    }
    const beams = computeBeams(notes, beats, beatType);
    let duration = 0;
    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      if (note.attributeChange !== undefined) {
        children.push(attributeChangeXml(note.attributeChange, staffNumber));
      }
      children.push(noteXml(note, beams.get(index) ?? [], staffNumber));
      // Chord tail notes share the previous note's time slot (no advance).
      if (!note.chord) {
        duration += noteDivisions(note);
      }
    }
    previousDuration = duration;
  }
  return wrapMeasure(measureNumber, children);
}

/**
 * Assemble a MusicXML document from a sequence of systems (in time order). The
 * systems are concatenated into one part: single-staff systems flow into one
 * staff, while a system whose staves were paired (a grand staff) places its
 * staves into `<staff>1</staff>`, `<staff>2</staff>`, … of the same part. A
 * single-staff score routes through {@link buildMusicXML} for byte-identical
 * output.
 */
export function buildScore(
  systems: ScoreSystem[],
  options: BuildOptions = {},
): string {
  const partName = options.partName ?? "Music";
  const staffCount = systems.reduce(
    (max, system) => Math.max(max, system.staves.length),
    1,
  );

  if (staffCount === 1) {
    // The opening clef is never guessed: if TrOMR did not recover it, refuse to
    // build rather than emit a plausible-but-wrong clef. (buildMusicXML's own
    // treble default is a convenience for low-level/test use; the OMR pipeline
    // goes through buildScore, which enforces a recognized clef here.)
    const firstStaff = systems[0]?.staves[0];
    if (firstStaff !== undefined && firstStaff.attributes.clef === undefined) {
      throw new Error(
        "No clef was recognized for the staff; refusing to guess. Inspect the " +
          "[omr] TrOMR token logs in the console to see what was decoded.",
      );
    }
    // Concatenate single-staff systems sequentially (each numbers measures from
    // 0) and reuse the single-staff builder unchanged.
    const notes = combinePages(
      systems.map((system) => system.staves[0]?.notes ?? []),
    );
    return buildMusicXML(notes, {
      attributes: firstStaff?.attributes,
      partName,
    });
  }

  // Place every system's staves onto a shared measure grid. Each system numbers
  // its measures from 0; offset by the running total so systems run in sequence.
  const staffAttributes: (ScoreAttributes | undefined)[] = new Array(staffCount);
  const measureStaffNotes: NoteEvent[][][] = [];
  const ensureMeasure = (measure: number): void => {
    while (measureStaffNotes.length <= measure) {
      measureStaffNotes.push(
        Array.from({ length: staffCount }, () => [] as NoteEvent[]),
      );
    }
  };

  let offset = 0;
  for (const system of systems) {
    let span = 0;
    for (const staff of system.staves) {
      span = Math.max(span, measureSpanOf(staff.notes));
    }
    for (let staffIndex = 0; staffIndex < system.staves.length; staffIndex++) {
      const staff = system.staves[staffIndex];
      staffAttributes[staffIndex] ??= staff.attributes;
      for (const note of staff.notes) {
        const measure = offset + note.measureIndex;
        ensureMeasure(measure);
        measureStaffNotes[measure][staffIndex].push(note);
      }
    }
    offset += span;
  }
  ensureMeasure(0); // always at least one measure

  // Track the meter at each measure's start (top staff), for beams and rests.
  let beats = staffAttributes[0]?.time?.beats ?? DEFAULT_BEATS;
  let beatType = staffAttributes[0]?.time?.beatType ?? DEFAULT_BEAT_TYPE;
  const openingAttributes = grandStaffAttributesXml(staffAttributes);
  const measures = measureStaffNotes.map((staffNotes, index) => {
    const xml = grandStaffMeasureXml(
      staffNotes,
      index + 1,
      index === 0 ? openingAttributes : null,
      beats,
      beatType,
    );
    for (const note of staffNotes[0]) {
      if (note.attributeChange?.time !== undefined) {
        beats = note.attributeChange.time.beats;
        beatType = note.attributeChange.time.beatType;
      }
    }
    return xml;
  });

  return wrapDocument(partName, measures);
}

/** Wrap rendered `<measure>` strings in the score/part/part-list boilerplate. */
function wrapDocument(partName: string, measures: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"',
    '  "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="3.1">',
    "  <part-list>",
    '    <score-part id="P1">',
    `      <part-name>${escapeXml(partName)}</part-name>`,
    "    </score-part>",
    "  </part-list>",
    '  <part id="P1">',
    ...measures,
    "  </part>",
    "</score-partwise>",
  ].join("\n");
}
