import { describe, expect, it } from "bun:test";
import type { NoteEvent } from "../types";
import { buildMusicXML } from "./musicxml-builder";

function note(
  pitch: string | "rest",
  duration: NoteEvent["duration"],
  measureIndex = 0,
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch,
    duration,
    dotted: false,
    accidental: "natural",
    measureIndex,
    chord: false,
    ...extra,
  };
}

describe("buildMusicXML", () => {
  it("produces a valid XML declaration and root element", () => {
    const xml = buildMusicXML([]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<score-partwise");
    expect(xml).toContain("</score-partwise>");
  });

  it("includes required first-measure attributes", () => {
    const xml = buildMusicXML([note("C4", "quarter")]);
    expect(xml).toContain("<divisions>4</divisions>");
    expect(xml).toContain("<fifths>0</fifths>");
    expect(xml).toContain("<beats>4</beats>");
    expect(xml).toContain("<beat-type>4</beat-type>");
  });

  it("encodes a quarter note correctly", () => {
    const xml = buildMusicXML([note("C4", "quarter")]);
    expect(xml).toContain("<step>C</step>");
    expect(xml).toContain("<octave>4</octave>");
    expect(xml).toContain("<duration>4</duration>");
    expect(xml).toContain("<type>quarter</type>");
  });

  it("encodes a rest correctly", () => {
    const xml = buildMusicXML([note("rest", "half")]);
    expect(xml).toContain("<rest/>");
    expect(xml).toContain("<duration>8</duration>");
    expect(xml).toContain("<type>half</type>");
  });

  it("encodes a dotted quarter note", () => {
    const xml = buildMusicXML([note("E4", "quarter", 0, { dotted: true })]);
    expect(xml).toContain("<duration>6</duration>"); // 4 * 1.5
    expect(xml).toContain("<dot/>");
  });

  it("encodes a sharp accidental", () => {
    const xml = buildMusicXML([
      note("F4", "quarter", 0, { accidental: "sharp" }),
    ]);
    expect(xml).toContain("<alter>1</alter>");
    expect(xml).toContain("<accidental>sharp</accidental>");
  });

  it("encodes a flat accidental", () => {
    const xml = buildMusicXML([
      note("B4", "quarter", 0, { accidental: "flat" }),
    ]);
    expect(xml).toContain("<alter>-1</alter>");
    expect(xml).toContain("<accidental>flat</accidental>");
  });

  it("splits notes into separate measures by measureIndex", () => {
    const xml = buildMusicXML([
      note("C4", "quarter", 0),
      note("D4", "quarter", 1),
    ]);
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure number="2"');
  });

  it("fills an empty measure with a whole rest", () => {
    // Two notes in measure 0, gap at measure 1, note in measure 2
    const xml = buildMusicXML([
      note("C4", "quarter", 0),
      note("E4", "quarter", 2),
    ]);
    // Measure 1 should get a whole-measure rest
    expect(xml).toContain('measure="yes"');
  });

  it("produces valid XML for an empty note list", () => {
    const xml = buildMusicXML([]);
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure="yes"');
  });

  it("counts measures by the maximum index, not the last note", () => {
    // Notes from a later staff renumber measures from 0, so the final note can
    // hold a lower measureIndex than an earlier one. The builder must size the
    // measure list by the maximum index to avoid indexing past its end.
    const xml = buildMusicXML([
      note("C4", "quarter", 0),
      note("D4", "quarter", 1),
      note("E4", "quarter", 2),
      note("F4", "quarter", 0),
    ]);
    expect(xml).toContain('measure number="3"');
  });

  it("emits <chord/> before <pitch> for chord notes", () => {
    const xml = buildMusicXML([
      note("C4", "quarter", 0),
      note("E4", "quarter", 0, { chord: true }),
      note("G4", "quarter", 0, { chord: true }),
    ]);
    // The second and third notes must carry <chord/>
    const chordOccurrences = (xml.match(/<chord\/>/g) ?? []).length;
    expect(chordOccurrences).toBe(2);
    // <chord/> must appear before <pitch> within each chord note
    const firstChordPos = xml.indexOf("<chord/>");
    const firstPitchAfterChord = xml.indexOf("<pitch>", firstChordPos);
    expect(firstPitchAfterChord).toBeGreaterThan(firstChordPos);
  });

  it("does not include attributes on subsequent measures", () => {
    const xml = buildMusicXML([
      note("C4", "quarter", 0),
      note("D4", "quarter", 1),
    ]);
    const firstMeasureEnd = xml.indexOf("</measure>");
    const secondMeasureContent = xml.slice(firstMeasureEnd);
    // <clef> should only appear in the first measure
    expect(xml.indexOf("<clef>")).toBeLessThan(firstMeasureEnd);
    expect(secondMeasureContent).not.toContain("<clef>");
  });
});
