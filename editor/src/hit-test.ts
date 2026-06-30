// Screen ⇄ music coordinate inverses for the editor, plus note picking. These
// reuse the vendored renderer's forward maps (`computeCursorX`, `noteY`,
// `resolveLayout`) so a click resolves to exactly the beat/pitch the renderer
// would have drawn.

import type { NoteHandle } from "./dom-edit";
import {
  BASS_BOTTOM,
  type ChordGroup,
  computeMeasureStartBeats,
  diatonicIndex,
  DIVISIONS,
  isRest,
  keyAlterForStep,
  type NoteType,
  type ParsedScore,
  type Pitch,
  type ResolvedLayout,
  TREBLE_BOTTOM,
} from "./sheet-music/index";

// Finest editing grid: a quarter of a beat (a 16th note).
export const SNAP_BEATS = 0.25;

const STEPS: Pitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

function beatsPerMeasureOf(score: ParsedScore): number {
  const timeSig = score.parts[0]?.timeSig ?? { beats: 4, beatType: 4 };
  return timeSig.beats * (4 / timeSig.beatType);
}

// Invert the renderer's measure x layout to turn an SVG x into an absolute
// quarter-note beat. Rather than linear interpolation across the measure width
// (which ignores the clef/key/time lead-in that pushes the first note right of
// the barline), this resolves the click to the nearest actual onset position
// from the shared rhythm spine, so a click on a notehead maps to that note's
// exact beat.
export function beatFromX(
  svgX: number,
  score: ParsedScore,
  layout: ResolvedLayout,
  measureStartBeats: number[],
): number {
  let measureIndex = 0;
  for (let i = 0; i < layout.measureXs.length; i++) {
    if (layout.measureXs[i] <= svgX) {
      measureIndex = i;
    }
  }
  const beatsPerMeasure = beatsPerMeasureOf(score);
  const measureStart =
    measureStartBeats[measureIndex] ?? measureIndex * beatsPerMeasure;
  const measureEnd =
    measureStartBeats[measureIndex + 1] ?? measureStart + beatsPerMeasure;

  const spine = layout.measureSpines[measureIndex];
  if (!spine || spine.divs.length === 0) {
    return measureStart;
  }

  // Find the spine onset whose x is nearest to the click.
  let bestIndex = 0;
  let bestDist = Math.abs(spine.xs[0] - svgX);
  for (let i = 1; i < spine.xs.length; i++) {
    const d = Math.abs(spine.xs[i] - svgX);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }

  // spine.divs is in layout divisions (DIVISIONS = 4 per quarter note).
  const beat = measureStart + spine.divs[bestIndex] / DIVISIONS;
  return Math.max(measureStart, Math.min(beat, measureEnd - SNAP_BEATS));
}

// Split an absolute beat into its measure index + onset within that measure.
export function locateBeat(
  beat: number,
  measureStartBeats: number[],
): { measureIndex: number; onsetBeatInMeasure: number } {
  let measureIndex = 0;
  for (let i = 0; i < measureStartBeats.length; i++) {
    if (measureStartBeats[i] <= beat + 1e-9) {
      measureIndex = i;
    }
  }
  return {
    measureIndex,
    onsetBeatInMeasure: beat - measureStartBeats[measureIndex],
  };
}

// Invert `noteY` (a linear diatonic-step map) to turn an SVG y into a pitch,
// snapping to the nearest half staff-space (natural staff-line/space position).
// `alter` is 0 in step 1 (no key-signature or accidental inference yet).
export function pitchFromY(
  svgY: number,
  staffBottomY: number,
  staffSpace: number,
  clef: { sign: "G" | "F" },
): Pitch {
  const bottomRef = clef.sign === "G" ? TREBLE_BOTTOM : BASS_BOTTOM;
  const stepsFromBottom = Math.round((staffBottomY - svgY) / (staffSpace / 2));
  const diatonic = stepsFromBottom + bottomRef;
  const octave = Math.floor(diatonic / 7);
  const stepIndex = ((diatonic % 7) + 7) % 7;
  return { step: STEPS[stepIndex], alter: 0, octave };
}

// One pickable parsed note, with everything needed to select it and to edit it.
interface PickableNote {
  id: string;
  beat: number;
  pitch: Pitch;
  handle: NoteHandle;
}

// Enumerate every parsed note with its absolute beat, renderer id, and source
// handle. Notes without `source` provenance (e.g. multi-staff reductions) are
// skipped — the editor's scope is the single-staff path that populates it.
function pickableNotes(score: ParsedScore): PickableNote[] {
  const measureStartBeats = computeMeasureStartBeats(score);
  const result: PickableNote[] = [];
  score.parts.forEach((part, partIndex) => {
    part.measures.forEach((measure, measureIndex) => {
      let beatCursor = measureStartBeats[measureIndex] ?? 0;
      const divisions = measure.divisions || 4;
      for (const event of measure.events) {
        if (isRest(event)) {
          beatCursor += event.duration / divisions;
          continue;
        }
        const group = event as ChordGroup;
        group.notes.forEach((note, voiceIndex) => {
          if (!note.source) {
            return;
          }
          result.push({
            id: `p${partIndex}-m${measure.number}-n${group.noteIndex}-v${voiceIndex}`,
            beat: beatCursor,
            pitch: note.pitch,
            handle: note.source,
          });
        });
        beatCursor += group.duration / divisions;
      }
    });
  });
  return result;
}

// Find the parsed note nearest a clicked (beat, pitch), within a small
// tolerance. Returns its renderer id (for the selection highlight) and source
// handle (for dom-edit), or null when nothing is close enough.
export function pickNote(
  score: ParsedScore,
  beat: number,
  pitch: Pitch,
): { id: string; handle: NoteHandle } | null {
  const targetDiatonic = diatonicIndex(pitch);
  // Tolerances: within ~a quarter note horizontally, ~a third vertically.
  const beatTolerance = 0.75;
  const pitchTolerance = 3;
  let best: PickableNote | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of pickableNotes(score)) {
    const beatDistance = Math.abs(candidate.beat - beat);
    const pitchDistance = Math.abs(
      diatonicIndex(candidate.pitch) - targetDiatonic,
    );
    if (beatDistance > beatTolerance || pitchDistance > pitchTolerance) {
      continue;
    }
    // Weight beats more heavily so two stacked pitches at the same onset resolve
    // by which is vertically closer, but distinct onsets win first.
    const score_ = beatDistance * 4 + pitchDistance;
    if (score_ < bestScore) {
      bestScore = score_;
      best = candidate;
    }
  }
  return best ? { id: best.id, handle: best.handle } : null;
}

// The renderer id + handle for a known note handle, used to keep a selection
// highlight attached to a note across edits. Returns null if the handle no
// longer resolves (e.g. the note was removed).
export function idForHandle(
  score: ParsedScore,
  handle: NoteHandle,
): string | null {
  for (const note of pickableNotes(score)) {
    if (
      note.handle.measureIndex === handle.measureIndex &&
      note.handle.noteElementIndex === handle.noteElementIndex
    ) {
      return note.id;
    }
  }
  return null;
}

function sameHandle(a: NoteHandle, b: NoteHandle): boolean {
  return (
    a.measureIndex === b.measureIndex &&
    a.noteElementIndex === b.noteElementIndex
  );
}

// A chord = the notes a single beat sounds together: every parsed note sharing
// one onset (a `ChordGroup`). `onsetBeat` is absolute; `handles` are the source
// handles of all its real notes (chord members included). The selection model
// builds on these so a click can select the whole beat before narrowing.
export interface ChordSelection {
  /** Which parsed part (staff) the chord lives on — 0 for a single staff, or the
   *  treble/bass staff of a grand staff. Lets selection target the right staff. */
  partIndex: number;
  measureIndex: number;
  onsetBeat: number;
  handles: NoteHandle[];
}

// Enumerate every chord (onset group) with its absolute beat and note handles.
// Mirrors `pickableNotes`' beat-cursor walk but groups by `ChordGroup` rather
// than flattening to individual notes.
function pickableChords(score: ParsedScore): ChordSelection[] {
  const measureStartBeats = computeMeasureStartBeats(score);
  const result: ChordSelection[] = [];
  score.parts.forEach((part, partIndex) => {
    part.measures.forEach((measure, measureIndex) => {
      let beatCursor = measureStartBeats[measureIndex] ?? 0;
      const divisions = measure.divisions || 4;
      for (const event of measure.events) {
        if (isRest(event)) {
          beatCursor += event.duration / divisions;
          continue;
        }
        const group = event as ChordGroup;
        const handles = group.notes
          .map((note) => note.source)
          .filter((source): source is NoteHandle => source !== undefined);
        if (handles.length > 0) {
          result.push({
            partIndex,
            measureIndex,
            onsetBeat: beatCursor,
            handles,
          });
        }
        beatCursor += group.duration / divisions;
      }
    });
  });
  return result;
}

// The chord (onset group) a known note belongs to, or null if the handle no
// longer resolves. Used to widen a picked note to its whole beat.
export function chordForHandle(
  score: ParsedScore,
  handle: NoteHandle,
): ChordSelection | null {
  for (const chord of pickableChords(score)) {
    if (chord.handles.some((candidate) => sameHandle(candidate, handle))) {
      return chord;
    }
  }
  return null;
}

// The pitch of the note a handle refers to, or null if it no longer resolves.
export function pitchForHandle(
  score: ParsedScore,
  handle: NoteHandle,
): Pitch | null {
  for (const note of pickableNotes(score)) {
    if (sameHandle(note.handle, handle)) {
      return note.pitch;
    }
  }
  return null;
}

// Shift a pitch by a number of diatonic steps (±1 = one staff position). The
// resulting alteration is taken from the key signature so ↑/↓ stays diatonic
// in the active key (F♯ in G major, B♭ in F major, etc.). Pass `fifths = 0`
// (the default) for C-major / atonal behaviour.
export function stepPitch(pitch: Pitch, deltaSteps: number, fifths = 0): Pitch {
  const index = diatonicIndex(pitch) + deltaSteps;
  const octave = Math.floor(index / 7);
  const stepIndex = ((index % 7) + 7) % 7;
  const step = STEPS[stepIndex];
  return { step, alter: keyAlterForStep(step, fifths), octave };
}

// Shift a pitch by whole octaves, preserving its step and accidental (used by
// Shift+↑/↓). Unlike `stepPitch` this keeps any alteration.
export function octavePitch(pitch: Pitch, deltaOctaves: number): Pitch {
  return { ...pitch, octave: pitch.octave + deltaOctaves };
}

// ── Rich chord info (for the inspector) ───────────────────────────────────────

// One note of a chord, with everything the inspector and overlay need: the
// renderer id (highlight), the source handle (edit), and the pitch (label +
// ordering).
export interface ChordNote {
  id: string;
  handle: NoteHandle;
  pitch: Pitch;
}

// A selectable beat with its note rows and duration type — the inspector's data
// model. Mirrors `pickableChords` but carries per-note id/pitch and the chord's
// `NoteType`.
export interface ChordInfo {
  partIndex: number;
  measureIndex: number;
  onsetBeat: number;
  type: NoteType;
  notes: ChordNote[];
}

function pickableChordInfos(score: ParsedScore): ChordInfo[] {
  const measureStartBeats = computeMeasureStartBeats(score);
  const result: ChordInfo[] = [];
  score.parts.forEach((part, partIndex) => {
    part.measures.forEach((measure, measureIndex) => {
      let beatCursor = measureStartBeats[measureIndex] ?? 0;
      const divisions = measure.divisions || 4;
      for (const event of measure.events) {
        if (isRest(event)) {
          beatCursor += event.duration / divisions;
          continue;
        }
        const group = event as ChordGroup;
        const notes: ChordNote[] = [];
        group.notes.forEach((note, voiceIndex) => {
          if (!note.source) {
            return;
          }
          notes.push({
            id: `p${partIndex}-m${measure.number}-n${group.noteIndex}-v${voiceIndex}`,
            handle: note.source,
            pitch: note.pitch,
          });
        });
        if (notes.length > 0) {
          result.push({
            partIndex,
            measureIndex,
            onsetBeat: beatCursor,
            type: group.type,
            notes,
          });
        }
        beatCursor += group.duration / divisions;
      }
    });
  });
  return result;
}

// The rich chord info for the beat a known note belongs to, or null if the
// handle no longer resolves.
export function chordInfoForHandle(
  score: ParsedScore,
  handle: NoteHandle,
): ChordInfo | null {
  for (const info of pickableChordInfos(score)) {
    if (info.notes.some((note) => sameHandle(note.handle, handle))) {
      return info;
    }
  }
  return null;
}

// The rich chord info nearest `beat`, within `tolerance` quarter-note beats.
export function chordInfoAtBeat(
  score: ParsedScore,
  beat: number,
  tolerance = 1.5,
): ChordInfo | null {
  let best: ChordInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const info of pickableChordInfos(score)) {
    const distance = Math.abs(info.onsetBeat - beat);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = info;
    }
  }
  return best && bestDistance <= tolerance ? best : null;
}

// Top-first (descending pitch) ordering of a chord's notes — the single helper
// the inspector rows and any note-cycling must share so list order and on-score
// positions stay aligned (per the handoff's State Management note).
export function topFirstNotes(info: { notes: ChordNote[] }): ChordNote[] {
  return [...info.notes].sort(
    (a, b) => diatonicIndex(b.pitch) - diatonicIndex(a.pitch),
  );
}

// ── Spine slots (rest-inclusive positions) ────────────────────────────────────

// One position on the rhythm spine — a chord OR a rest. Selection is
// slot-centric: a click (or ←/→) lands on a slot regardless of whether a note
// sounds there, so rests are selectable and an empty measure has one slot. A
// rest slot carries no notes/handles; its `type` is the rest's duration value.
export interface SlotInfo {
  /** Which parsed part (staff) this slot belongs to — 0 for a single staff, or
   *  the treble (0) / bass (1) staff of a grand staff. */
  partIndex: number;
  measureIndex: number;
  onsetBeat: number;
  isRest: boolean;
  /** Duration value of the rest or chord (for the inspector's duration label). */
  type: NoteType;
  /** Chord members, top-first ordering applied by the caller; empty for a rest. */
  notes: ChordNote[];
  /** Source handles of the chord's notes; empty for a rest. */
  handles: NoteHandle[];
}

// Enumerate every slot (chord and rest) in onset order across all measures.
// Mirrors `pickableChordInfos`' beat-cursor walk but emits a slot for rests too.
function pickableSlots(score: ParsedScore): SlotInfo[] {
  const measureStartBeats = computeMeasureStartBeats(score);
  const result: SlotInfo[] = [];
  score.parts.forEach((part, partIndex) => {
    part.measures.forEach((measure, measureIndex) => {
      let beatCursor = measureStartBeats[measureIndex] ?? 0;
      const divisions = measure.divisions || 4;
      for (const event of measure.events) {
        if (isRest(event)) {
          result.push({
            partIndex,
            measureIndex,
            onsetBeat: beatCursor,
            isRest: true,
            type: event.type,
            notes: [],
            handles: [],
          });
          beatCursor += event.duration / divisions;
          continue;
        }
        const group = event as ChordGroup;
        const notes: ChordNote[] = [];
        group.notes.forEach((note, voiceIndex) => {
          if (!note.source) {
            return;
          }
          notes.push({
            id: `p${partIndex}-m${measure.number}-n${group.noteIndex}-v${voiceIndex}`,
            handle: note.source,
            pitch: note.pitch,
          });
        });
        result.push({
          partIndex,
          measureIndex,
          onsetBeat: beatCursor,
          isRest: false,
          type: group.type,
          notes,
          handles: notes.map((note) => note.handle),
        });
        beatCursor += group.duration / divisions;
      }
    });
  });
  return result;
}

// Every slot in onset order — drives ←/→ navigation, including rests and empty
// measures (not just note onsets). Pass `partIndex` to walk one staff of a grand
// staff (so ←/→ stays on the staff the user is editing).
export function slots(score: ParsedScore, partIndex?: number): SlotInfo[] {
  const all = pickableSlots(score);
  return partIndex === undefined
    ? all
    : all.filter((slot) => slot.partIndex === partIndex);
}

// Re-resolve a selected slot (a position) to fresh data after an edit. Matched
// by measure + onset beat so it survives rebuilds — including rests, which carry
// no handle. `partIndex` disambiguates the two staves of a grand staff (without
// it, the first matching staff wins — back-compatible for single-staff scores).
export function slotAt(
  score: ParsedScore,
  measureIndex: number,
  onsetBeat: number,
  partIndex?: number,
): SlotInfo | null {
  for (const slot of pickableSlots(score)) {
    if (
      slot.measureIndex === measureIndex &&
      Math.abs(slot.onsetBeat - onsetBeat) < 1e-6 &&
      (partIndex === undefined || slot.partIndex === partIndex)
    ) {
      return slot;
    }
  }
  return null;
}

// Every slot at a specific (measureIndex, onsetBeat) position across all parts.
// Used by the inspector to show notes from all staves when a beat is selected.
export function allSlotsAtBeat(
  score: ParsedScore,
  measureIndex: number,
  onsetBeat: number,
): SlotInfo[] {
  return score.parts
    .map((_, partIndex) => slotAt(score, measureIndex, onsetBeat, partIndex))
    .filter((slot): slot is SlotInfo => slot !== null);
}

// The slot whose onset is nearest `beat`, within `tolerance` quarter-note beats.
// The rest-aware counterpart of `chordInfoAtBeat`: a click snapped by `beatFromX`
// to a spine onset lands exactly on its slot. `partIndex` restricts the search to
// one staff of a grand staff so a click on the bass staff resolves a bass slot.
export function slotAtBeat(
  score: ParsedScore,
  beat: number,
  tolerance = 1.5,
  partIndex?: number,
): SlotInfo | null {
  let best: SlotInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of pickableSlots(score)) {
    if (partIndex !== undefined && slot.partIndex !== partIndex) {
      continue;
    }
    const distance = Math.abs(slot.onsetBeat - beat);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best && bestDistance <= tolerance ? best : null;
}
