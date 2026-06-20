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
import { type BeamElement, computeBeams } from "./beams";
import { DIVISIONS, DURATION_DIVISIONS } from "./durations";

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

function noteXml(note: NoteEvent, beams: BeamElement[]): string {
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
function attributeChangeXml(change: ScoreAttributes): string {
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
    lines.push(
      `  <clef><sign>${escapeXml(change.clef.sign)}</sign>` +
        `<line>${change.clef.line}</line></clef>`,
    );
  }
  lines.push("</attributes>");
  return lines.join("\n");
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
