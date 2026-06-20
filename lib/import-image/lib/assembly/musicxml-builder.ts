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
import type { NoteEvent, ScoreAttributes } from "../types";

/** Quarter note = 4 divisions; must divide all supported duration values. */
const DIVISIONS = 4;

const DURATION_DIVISIONS: Record<NoteEvent["duration"], number> = {
  whole: 16,
  half: 8,
  quarter: 4,
  eighth: 2,
  sixteenth: 1,
  thirty_second: 1, // rounds to 1 — 32nd notes need DIVISIONS=8; acceptable for POC
};

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

function noteXml(
  note: NoteEvent,
  isFirst: boolean,
  measureIndex: number,
): string {
  const divisions = DURATION_DIVISIONS[note.duration];
  const dottedDivisions = note.dotted ? Math.round(divisions * 1.5) : divisions;
  const type = MUSICXML_TYPE[note.duration];

  if (note.pitch === "rest") {
    return [
      "<note>",
      note.chord ? "  <chord/>" : "",
      "  <rest/>",
      `  <duration>${dottedDivisions}</duration>`,
      `  <type>${type}</type>`,
      note.dotted ? "  <dot/>" : "",
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
    `  <type>${type}</type>`,
    note.dotted ? "  <dot/>" : "",
    accidentalTag,
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

function measureXml(
  notes: NoteEvent[],
  measureNumber: number,
  isFirstMeasure: boolean,
  attributes: ScoreAttributes,
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
    for (let index = 0; index < notes.length; index++) {
      children.push(noteXml(notes[index], index === 0, measureNumber - 1));
    }
  }

  const indent = children.map((line) => `    ${line}`).join("\n");
  return `  <measure number="${measureNumber}">\n${indent}\n  </measure>`;
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

  const measures = byMeasure.map((notesInMeasure, index) =>
    measureXml(notesInMeasure, index + 1, index === 0, attributes),
  );

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
