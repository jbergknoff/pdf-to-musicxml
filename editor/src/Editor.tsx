// Editor shell: owns the live MusicXML Document, the selection, import/export,
// and playback. The Document is the source of truth (held in a ref); a `version`
// counter forces a re-render after each in-place mutation, and the serialized
// string is recomputed from it.
//
// Interaction is selection-first and keyboard-driven (per the Claude Design
// handoff): a click selects the whole chord at a beat (Level 1); a second click
// on a notehead — or Enter — drills to a single note (Level 2); Esc steps back
// out. The right-hand inspector mirrors the selection and edits pitch /
// accidental / chord membership with discrete commands. Arrow keys re-pitch the
// drilled note (↑/↓) or move between beats (←/→); A–G add a note; -/=/0 set
// accidentals; Space plays/stops. A plain drag only scrolls the staff.

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import {
  type ContextMenuRequest,
  EditableSheetMusic,
  type EditorGesture,
} from "./components/EditableSheetMusic";
import {
  Inspector,
  type InspectorModel,
  type InspectorNoteGroup,
} from "./components/Inspector";
import { MetadataDialog } from "./components/MetadataDialog";
import { ScoreHeader } from "./components/ScoreHeader";
import {
  type EditableMetadata,
  readMetadata,
  stampImportProvenance,
  writeMetadata,
} from "./metadata";
import {
  addNote,
  addNoteToChord,
  createBlankDocument,
  insertMeasure,
  isEditableDocument,
  moveNote,
  type NoteHandle,
  parseDocument,
  removeGraceNote,
  removeNotes,
  reorderGrace,
  serializeDocument,
  setAccidental,
  setGracePitch,
  setGraceSlash,
  setNoteDuration,
} from "./dom-edit";
import {
  allSlotsAtBeat,
  chordForHandle,
  chordInfoForHandle,
  idForHandle,
  octavePitch,
  pitchForHandle,
  type SlotInfo,
  slotAt,
  slotAtBeat,
  slots,
  stepPitch,
  topFirstNotes,
} from "./hit-test";
import {
  computeMeasureStartBeats,
  type NoteHighlight,
  type NoteType,
  type Pitch,
  parseScore,
} from "./sheet-music/index";
import { parseMidi } from "midi-file";
import { extractMusicXmlFromMxl } from "../../lib/mxl";
import {
  getMidiTracks,
  midiToMusicXmlWithTracks,
} from "../../lib/midi-to-musicxml";
import { COLORS, FONTS, LAYOUT, RADIUS } from "./theme";
import { useHistory } from "./use-history";
import { isImportableImage, useImageImport } from "./use-image-import";
import { useListen } from "./use-listen";

function isMxl(file: File): boolean {
  return file.name.toLowerCase().endsWith(".mxl");
}

function isMidi(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".mid") ||
    name.endsWith(".midi") ||
    file.type === "audio/midi" ||
    file.type === "audio/x-midi"
  );
}

// A focused note draws solid accent; its chord-mates draw a lighter tint.
const FOCUS_COLOR = COLORS.accent;
const CHORD_TINT = "#84a9e8";

// Undotted note-value → quarter-note beats, for the inspector's duration
// selector (mirrors dom-edit's own standard-duration table).
const BEATS_BY_TYPE: Record<NoteType, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
};

// The current selection: either a whole spine slot (Level 1) — a position that
// may hold a chord OR a rest — or one focused note within a chord (Level 2). A
// slot is identified by its position (measure + onset beat) so it survives edits
// even when it holds no note (a rest carries no handle).
type Selection =
  | { kind: "slot"; partIndex: number; measureIndex: number; onsetBeat: number }
  | { kind: "note"; handle: NoteHandle }
  | null;

function sameHandle(a: NoteHandle, b: NoteHandle): boolean {
  return (
    a.measureIndex === b.measureIndex &&
    a.noteElementIndex === b.noteElementIndex
  );
}

function sameSlot(
  selection: Selection,
  slot: { partIndex: number; measureIndex: number; onsetBeat: number },
): boolean {
  return (
    selection?.kind === "slot" &&
    selection.partIndex === slot.partIndex &&
    selection.measureIndex === slot.measureIndex &&
    Math.abs(selection.onsetBeat - slot.onsetBeat) < 1e-6
  );
}

// The single-note target for nudges/accidentals: an explicitly focused note, or
// a chord slot that holds exactly one note. A rest slot has no target.
function focusedHandle(
  selection: Selection,
  slot: SlotInfo | null,
): NoteHandle | null {
  if (selection?.kind === "note") {
    return selection.handle;
  }
  if (slot && !slot.isRest && slot.handles.length === 1) {
    return slot.handles[0];
  }
  return null;
}

const STEPS_ORDER: Pitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

// A new note added onto a rest is placed near the staff's middle line for the
// active clef (B4 treble, D3 bass) so it lands on the staff rather than far
// above/below — the user nudges from there with ↑/↓.
function staffReferencePitch(clef: { sign: "G" | "F" } | undefined): Pitch {
  return clef?.sign === "F"
    ? { step: "D", alter: 0, octave: 3 }
    : { step: "B", alter: 0, octave: 4 };
}

// Place a chosen letter (A–G) at the octave that lands it nearest the staff's
// middle line for the clef — so typing "C" onto an empty treble bar gives C5,
// not C4 far below.
function placeLetterNearStaff(
  step: Pitch["step"],
  clef: { sign: "G" | "F" } | undefined,
): Pitch {
  const reference = staffReferencePitch(clef);
  const referenceDiatonic =
    reference.octave * 7 + STEPS_ORDER.indexOf(reference.step);
  const stepIndex = STEPS_ORDER.indexOf(step);
  let best = Math.round((referenceDiatonic - stepIndex) / 7);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const octave of [best - 1, best, best + 1]) {
    const distance = Math.abs(octave * 7 + stepIndex - referenceDiatonic);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = octave;
    }
  }
  return { step, alter: 0, octave: best };
}

// A pitch's display accidental for the inspector label.
function accidentalSymbol(alter: number): string {
  if (alter >= 2) {
    return "♯♯";
  }
  if (alter === 1) {
    return "♯";
  }
  if (alter === -1) {
    return "♭";
  }
  if (alter <= -2) {
    return "♭♭";
  }
  return "";
}

function pitchLabel(pitch: Pitch): string {
  return `${pitch.step}${accidentalSymbol(pitch.alter)}${pitch.octave}`;
}

// Shared style for the plain toolbar buttons, dimmed when disabled.
function toolbarButtonStyle(enabled: boolean) {
  return {
    padding: "6px 12px",
    borderRadius: RADIUS.button,
    border: `1px solid ${COLORS.borderButton}`,
    background: COLORS.canvas,
    color: enabled ? COLORS.textPrimary : COLORS.textPlaceholder,
    cursor: enabled ? "pointer" : "default",
    fontSize: 13,
    fontFamily: FONTS.ui,
  } as const;
}

export function Editor() {
  // Undo/redo + dirty tracking own the live document, the version counter, and
  // commit. The document is still mutated in place; commit snapshots it.
  const history = useHistory(createBlankDocument);
  const { documentRef, version, commit } = history;
  const [selection, setSelection] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const imageImport = useImageImport();

  // biome-ignore lint/correctness/useExhaustiveDependencies: version drives re-serialize after in-place mutations
  const musicxml = useMemo(
    () => serializeDocument(documentRef.current),
    [version],
  );
  const dirty = musicxml !== history.baselineXml;
  const score = useMemo(() => parseScore(musicxml), [musicxml]);
  const measureStartBeats = useMemo(
    () => computeMeasureStartBeats(score),
    [score],
  );
  // Whether the loaded document is in the editor's supported single-staff shape.
  // Multi-staff / multi-voice files are view-only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const editable = useMemo(
    () => isEditableDocument(documentRef.current),
    [version],
  );

  // Score-level metadata, re-read from the live document on each commit. Cheap,
  // so recomputed eagerly rather than only when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const metadata = useMemo(() => readMetadata(documentRef.current), [version]);

  const onSaveMetadata = useCallback(
    (values: EditableMetadata) => {
      writeMetadata(documentRef.current, values);
      setMetadataOpen(false);
      commit();
    },
    [documentRef, commit],
  );

  // The tempo "Listen" plays at — the score's configured BPM, or a default.
  const bpm = metadata.tempo ?? 100;
  const listen = useListen(score, bpm);

  // The slot (chord or rest) for the current selection. A slot selection
  // resolves by position; a drilled note resolves via its chord's onset.
  const slotInfo: SlotInfo | null = useMemo(() => {
    if (!selection) {
      return null;
    }
    if (selection.kind === "slot") {
      return slotAt(
        score,
        selection.measureIndex,
        selection.onsetBeat,
        selection.partIndex,
      );
    }
    const info = chordInfoForHandle(score, selection.handle);
    return info
      ? slotAt(score, info.measureIndex, info.onsetBeat, info.partIndex)
      : null;
  }, [selection, score]);

  // The single-note target for nudges/accidentals (null on a rest slot).
  const focused = useMemo(
    () => focusedHandle(selection, slotInfo),
    [selection, slotInfo],
  );

  // The inspector model + the parallel top-first handle list it indexes into.
  // A rest slot yields an empty note list, which the Inspector renders as
  // "Rest · {type}" with an Add-note affordance.
  // For grand staff, `allSlots` holds one SlotInfo per staff so the inspector
  // can show notes and Add-note buttons for each staff independently.
  const inspector = useMemo<{
    model: InspectorModel;
    handles: NoteHandle[];
    graceHandles: NoteHandle[];
    gracePitches: Pitch[];
    allSlots: SlotInfo[];
  } | null>(() => {
    if (!slotInfo) {
      return null;
    }
    const beatStaffSlots = allSlotsAtBeat(
      score,
      slotInfo.measureIndex,
      slotInfo.onsetBeat,
    );
    const numParts = score.parts.length;
    const flatHandles: NoteHandle[] = [];
    const flatGraceHandles: NoteHandle[] = [];
    const flatGracePitches: Pitch[] = [];
    const noteGroups: InspectorNoteGroup[] = beatStaffSlots.map((staffSlot) => {
      const rows = topFirstNotes(staffSlot);
      const offset = flatHandles.length;
      for (const row of rows) {
        flatHandles.push(row.handle);
      }
      const graceOffset = flatGraceHandles.length;
      for (const grace of staffSlot.graces) {
        flatGraceHandles.push(grace.handle);
        flatGracePitches.push(grace.pitch);
      }
      return {
        partIndex: staffSlot.partIndex,
        label:
          numParts > 1 ? (staffSlot.partIndex === 0 ? "Treble" : "Bass") : "",
        durationLabel: staffSlot.type,
        durationBeats: BEATS_BY_TYPE[staffSlot.type],
        isRest: staffSlot.isRest,
        noteOffset: offset,
        notes: rows.map((row) => ({
          key: row.id,
          label: pitchLabel(row.pitch),
          alter: row.pitch.alter,
          focused: focused ? sameHandle(row.handle, focused) : false,
        })),
        graceOffset,
        graces: staffSlot.graces.map((grace) => ({
          key: grace.id,
          label: pitchLabel(grace.pitch),
          alter: grace.pitch.alter,
          groupIndex: grace.groupIndex,
          groupCount: grace.groupCount,
          slash: grace.slash,
        })),
      };
    });

    const allNoteRows = noteGroups.flatMap((g) => g.notes);
    const measureStart = measureStartBeats[slotInfo.measureIndex] ?? 0;
    const beatType = score.parts[0]?.timeSig?.beatType ?? 4;
    const beatNumber =
      Math.round((slotInfo.onsetBeat - measureStart) * (beatType / 4)) + 1;
    return {
      model: {
        level: selection?.kind === "note" ? "note" : "beat",
        measureNumber: slotInfo.measureIndex + 1,
        beatNumber,
        durationLabel: slotInfo.type,
        notes: allNoteRows,
        noteGroups,
      },
      handles: flatHandles,
      graceHandles: flatGraceHandles,
      gracePitches: flatGracePitches,
      allSlots: beatStaffSlots,
    };
  }, [slotInfo, focused, selection, score, measureStartBeats]);

  // Selection highlights: at Level 2 the focused note draws strong and its
  // chord-mates light; a slot selection tints all its members across every
  // staff (none for a rest — the beat-box chrome marks a rest instead).
  const noteHighlights: NoteHighlight[] = useMemo(() => {
    if (!selection || !slotInfo) {
      return [];
    }
    if (selection.kind === "note") {
      const out: NoteHighlight[] = [];
      for (const note of slotInfo.notes) {
        const id = idForHandle(score, note.handle);
        if (id) {
          out.push({
            kind: "score",
            id,
            color: sameHandle(note.handle, selection.handle)
              ? FOCUS_COLOR
              : CHORD_TINT,
          });
        }
      }
      return out;
    }
    const slots = inspector?.allSlots ?? [slotInfo];
    return slots
      .flatMap((slot) => slot.notes)
      .map((note) => idForHandle(score, note.handle))
      .filter((id): id is string => id !== null)
      .map((id) => ({ kind: "score", id, color: CHORD_TINT }));
  }, [selection, score, slotInfo, inspector]);

  const hasSelection = selection !== null;

  // Selection chrome geometry: the beat column to highlight and (at Level 2) the
  // specific note to ring. Both are passed straight through to the renderer.
  const selectionBeat = slotInfo?.onsetBeat ?? null;
  const focusNoteId = useMemo(() => {
    if (selection?.kind !== "note") {
      return null;
    }
    return idForHandle(score, selection.handle) ?? null;
  }, [selection, score]);

  // Tap on the staff: select the spine slot (chord or rest) at that beat, then
  // narrow to one note on a repeat tap on a notehead. A tap that resolves to no
  // slot (off the staff) clears the selection — it never inserts a note.
  const handleTap = useCallback(
    (gesture: EditorGesture) => {
      setMenu(null);
      if (!editable) {
        return;
      }
      // A tap clear of the staves (in the empty margin) clears the selection;
      // it never selects or inserts.
      const slot = gesture.offStaff
        ? null
        : slotAtBeat(score, gesture.beat, 1.5, gesture.partIndex);
      if (!slot) {
        setSelection(null);
        return;
      }
      setSelection((prev) => {
        const onThisSlot =
          sameSlot(prev, slot) ||
          (prev?.kind === "note" &&
            slot.handles.some((handle) => sameHandle(handle, prev.handle)));
        // A repeat tap that landed on a notehead drills into that note.
        if (onThisSlot && gesture.hit) {
          return { kind: "note", handle: gesture.hit.handle };
        }
        return {
          kind: "slot",
          partIndex: slot.partIndex,
          measureIndex: slot.measureIndex,
          onsetBeat: slot.onsetBeat,
        };
      });
    },
    [editable, score],
  );

  const handleContextMenu = useCallback(
    (request: ContextMenuRequest) => {
      if (!editable) {
        return;
      }
      const slot = slotAtBeat(score, request.beat);
      if (!slot) {
        setMenu(null);
        return;
      }
      setSelection((prev) => {
        if (
          prev?.kind === "note" &&
          slot.handles.some((handle) => sameHandle(handle, prev.handle))
        ) {
          return prev;
        }
        return {
          kind: "slot",
          partIndex: slot.partIndex,
          measureIndex: slot.measureIndex,
          onsetBeat: slot.onsetBeat,
        };
      });
      setMenu({ x: request.clientX, y: request.clientY });
    },
    [editable, score],
  );

  // ── Editing operations ──────────────────────────────────────────────────────

  // Staff-step (or octave-step) a specific note, keeping its onset. Returns to
  // Level 2 on the moved note and coalesces a rapid run into one undo entry.
  const stepHandle = useCallback(
    (handle: NoteHandle, delta: number, octave: boolean) => {
      if (!editable) {
        return;
      }
      const pitch = pitchForHandle(score, handle);
      const chord = chordForHandle(score, handle);
      if (!pitch || !chord) {
        return;
      }
      const measureStart = measureStartBeats[chord.measureIndex] ?? 0;
      const activeFifths =
        score.parts[chord.partIndex]?.measures[chord.measureIndex]
          ?.activeFifths ?? 0;
      const moved = moveNote(documentRef.current, handle, {
        measureIndex: chord.measureIndex,
        onsetBeatInMeasure: chord.onsetBeat - measureStart,
        pitch: octave
          ? octavePitch(pitch, delta)
          : stepPitch(pitch, delta, activeFifths),
      });
      if (moved) {
        setSelection({ kind: "note", handle: moved });
        commit({ coalesce: "nudge" });
      }
    },
    [editable, score, measureStartBeats, documentRef, commit],
  );

  const setAccidentalOn = useCallback(
    (handle: NoteHandle, alter: number) => {
      if (!editable) {
        return;
      }
      if (setAccidental(documentRef.current, handle, alter)) {
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  // Resize the chord at `handle`'s onset (every member together) to a new
  // standard duration.
  const setDurationOn = useCallback(
    (handle: NoteHandle, durationBeats: number) => {
      if (!editable) {
        return;
      }
      if (setNoteDuration(documentRef.current, handle, durationBeats)) {
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  // Grace note edits never move the host's onset, so the active slot selection
  // (the beat) stays valid through any of these — no reselection needed.
  const setGraceAccidentalOn = useCallback(
    (handle: NoteHandle, alter: number) => {
      if (!editable) {
        return;
      }
      if (setAccidental(documentRef.current, handle, alter)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  const stepGraceHandle = useCallback(
    (handle: NoteHandle, pitch: Pitch, delta: number) => {
      if (!editable) {
        return;
      }
      const activeFifths =
        score.parts[slotInfo?.partIndex ?? 0]?.measures[handle.measureIndex]
          ?.activeFifths ?? 0;
      if (
        setGracePitch(
          documentRef.current,
          handle,
          stepPitch(pitch, delta, activeFifths),
        )
      ) {
        commit({ coalesce: "nudge" });
      }
    },
    [editable, score, slotInfo, documentRef, commit],
  );

  const removeGraceHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      if (removeGraceNote(documentRef.current, handle)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  const reorderGraceHandle = useCallback(
    (handle: NoteHandle, direction: "earlier" | "later") => {
      if (!editable) {
        return;
      }
      if (reorderGrace(documentRef.current, handle, direction)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  const setGraceSlashOn = useCallback(
    (handle: NoteHandle, slash: boolean) => {
      if (!editable) {
        return;
      }
      if (setGraceSlash(documentRef.current, handle, slash)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  // Re-select the slot at `onsetBeat` after a mutation, resolving against the
  // freshly serialized document so positions/handles are current. Used after a
  // removal so the position stays selected (it becomes a rest, or the remaining
  // chord).
  const reselectSlotAt = useCallback(
    (onsetBeat: number | null, partIndex: number) => {
      if (onsetBeat === null) {
        setSelection(null);
        return;
      }
      const freshScore = parseScore(serializeDocument(documentRef.current));
      const slot = slotAtBeat(freshScore, onsetBeat, 0.1, partIndex);
      setSelection(
        slot
          ? {
              kind: "slot",
              partIndex: slot.partIndex,
              measureIndex: slot.measureIndex,
              onsetBeat: slot.onsetBeat,
            }
          : null,
      );
    },
    [documentRef],
  );

  const removeHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      const info = chordInfoForHandle(score, handle);
      const onsetBeat = info?.onsetBeat ?? null;
      removeNotes(documentRef.current, [handle]);
      setMenu(null);
      commit();
      reselectSlotAt(onsetBeat, info?.partIndex ?? 0);
    },
    [editable, score, documentRef, commit, reselectSlotAt],
  );

  // Add a note at the current slot (or `targetSlot` for a specific staff). On a
  // chord slot it stacks a chord member (default a third above the top, via
  // `addNoteToChord`); on a rest slot it inserts a quarter note (`addNote` fits
  // the duration and rebalances). `pitch` is required for a rest.
  // `overrideOnsetBeat` lets the caller insert into a covering rest at a
  // specific beat rather than at the rest's own onset — used when adding a note
  // to an adjacent staff whose rest spans the selected beat.
  const addNoteAtSlot = useCallback(
    (pitch?: Pitch, targetSlot?: SlotInfo, overrideOnsetBeat?: number) => {
      const slot = targetSlot ?? slotInfo;
      if (!editable || !slot) {
        return;
      }
      if (slot.isRest) {
        const clef = score.parts[slot.partIndex]?.clef;
        const measureStart = measureStartBeats[slot.measureIndex] ?? 0;
        const onsetBeat = overrideOnsetBeat ?? slot.onsetBeat;
        const added = addNote(documentRef.current, {
          measureIndex: slot.measureIndex,
          onsetBeatInMeasure: onsetBeat - measureStart,
          durationBeats: 1,
          pitch: pitch ?? staffReferencePitch(clef),
          // 1-based staff; addNote ignores it for single-staff documents.
          staff: slot.partIndex + 1,
        });
        if (added) {
          setSelection({ kind: "note", handle: added });
          commit();
        }
        return;
      }
      const added = addNoteToChord(
        documentRef.current,
        slot.notes[0].handle,
        pitch,
      );
      if (added) {
        setSelection({ kind: "note", handle: added });
        commit();
      }
    },
    [editable, slotInfo, score, measureStartBeats, documentRef, commit],
  );

  const addLetter = useCallback(
    (step: Pitch["step"]) => {
      if (!slotInfo) {
        return;
      }
      if (slotInfo.isRest) {
        addNoteAtSlot(
          placeLetterNearStaff(step, score.parts[slotInfo.partIndex]?.clef),
        );
      } else {
        const top = topFirstNotes(slotInfo)[0].pitch;
        addNoteAtSlot({ step, alter: 0, octave: top.octave });
      }
    },
    [slotInfo, score, addNoteAtSlot],
  );

  const onInsertMeasure = useCallback(() => {
    if (!editable) {
      return;
    }
    insertMeasure(documentRef.current, slotInfo?.measureIndex);
    setSelection(null);
    setMenu(null);
    commit();
  }, [editable, slotInfo, documentRef, commit]);

  const deleteSelection = useCallback(() => {
    if (!selection || !slotInfo) {
      return;
    }
    const handles =
      selection.kind === "note" ? [selection.handle] : slotInfo.handles;
    if (handles.length === 0) {
      // A rest slot has nothing to delete.
      return;
    }
    const onsetBeat = slotInfo.onsetBeat;
    removeNotes(documentRef.current, handles);
    setMenu(null);
    commit();
    reselectSlotAt(onsetBeat, slotInfo.partIndex);
  }, [commit, documentRef, selection, slotInfo, reselectSlotAt]);

  // ── Selection navigation (keyboard) ─────────────────────────────────────────

  const drillIn = useCallback(() => {
    setSelection((prev) => {
      if (prev?.kind !== "slot") {
        return prev;
      }
      const slot = slotAt(
        score,
        prev.measureIndex,
        prev.onsetBeat,
        prev.partIndex,
      );
      // A rest slot has no note to drill into.
      if (!slot || slot.isRest || slot.notes.length === 0) {
        return prev;
      }
      return { kind: "note", handle: topFirstNotes(slot)[0].handle };
    });
  }, [score]);

  const stepOut = useCallback(() => {
    setMenu(null);
    setSelection((prev) => {
      if (prev?.kind !== "note") {
        return null;
      }
      const info = chordInfoForHandle(score, prev.handle);
      return info
        ? {
            kind: "slot",
            partIndex: info.partIndex,
            measureIndex: info.measureIndex,
            onsetBeat: info.onsetBeat,
          }
        : null;
    });
  }, [score]);

  const cycleChord = useCallback(
    (dir: number) => {
      setSelection((prev) => {
        if (prev?.kind !== "note") {
          return prev;
        }
        const info = chordInfoForHandle(score, prev.handle);
        if (!info) {
          return prev;
        }
        const rows = topFirstNotes(info);
        const index = rows.findIndex((row) =>
          sameHandle(row.handle, prev.handle),
        );
        if (index < 0) {
          return prev;
        }
        const next =
          (((index + dir) % rows.length) + rows.length) % rows.length;
        return { kind: "note", handle: rows[next].handle };
      });
    },
    [score],
  );

  // ←/→: move to the adjacent spine slot. Walks every slot (rests and empty
  // measures included), not just note onsets — the core "next spot on the spine"
  // behavior. Clamps at the piece ends.
  const navBeat = useCallback(
    (dir: number) => {
      // Walk one staff at a time so ←/→ stays on the staff being edited.
      const partIndex = slotInfo?.partIndex ?? 0;
      const list = slots(score, partIndex);
      if (list.length === 0) {
        return;
      }
      setSelection((prev) => {
        let index: number;
        if (!prev) {
          index = dir > 0 ? 0 : list.length - 1;
        } else {
          const current =
            prev.kind === "note"
              ? list.findIndex((slot) =>
                  slot.handles.some((handle) =>
                    sameHandle(handle, prev.handle),
                  ),
                )
              : list.findIndex((slot) => sameSlot(prev, slot));
          index = current < 0 ? (dir > 0 ? 0 : list.length - 1) : current + dir;
        }
        if (index < 0 || index >= list.length) {
          return prev; // clamp at the ends
        }
        const next = list[index];
        // Stay drilled to a note only when the destination actually holds one.
        if (prev?.kind === "note" && !next.isRest && next.notes.length > 0) {
          return { kind: "note", handle: topFirstNotes(next)[0].handle };
        }
        return {
          kind: "slot",
          partIndex: next.partIndex,
          measureIndex: next.measureIndex,
          onsetBeat: next.onsetBeat,
        };
      });
    },
    [score, slotInfo],
  );

  // ↑/↓: at Level 2 step the note (Shift = octave); at Level <2 drill in.
  const arrowPitch = useCallback(
    (dir: number, shift: boolean) => {
      if (selection?.kind === "note") {
        stepHandle(selection.handle, dir, shift);
      } else {
        drillIn();
      }
    },
    [selection, stepHandle, drillIn],
  );

  const accidentalOnFocus = useCallback(
    (alter: number) => {
      if (focused) {
        setAccidentalOn(focused, alter);
      }
    },
    [focused, setAccidentalOn],
  );

  const onListen = useCallback(() => {
    listen.toggle(slotInfo?.onsetBeat);
  }, [listen, slotInfo]);

  const undo = useCallback(() => {
    history.undo();
    setSelection(null);
    setMenu(null);
  }, [history]);

  const redo = useCallback(() => {
    history.redo();
    setSelection(null);
    setMenu(null);
  }, [history]);

  // Global keyboard map. Modifier combos (undo/redo) are always active; the
  // single-key commands are ignored while typing in a form field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (mod && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        redo();
        return;
      }
      if (mod) {
        return;
      }
      // Alt-modified keys are browser/OS shortcuts (e.g. Alt+D focuses the URL
      // bar). Leave them to the browser rather than treating Alt+letter as note
      // entry.
      if (event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }

      const key = event.key;
      if (key === " ") {
        event.preventDefault();
        onListen();
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        if (listen.playing) {
          listen.stop();
        }
        stepOut();
        return;
      }

      if (!editable) {
        return;
      }

      switch (key) {
        case "Enter":
          event.preventDefault();
          drillIn();
          return;
        case "Tab":
          event.preventDefault();
          cycleChord(event.shiftKey ? -1 : 1);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          deleteSelection();
          return;
        case "ArrowLeft":
          event.preventDefault();
          navBeat(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          navBeat(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          arrowPitch(1, event.shiftKey);
          return;
        case "ArrowDown":
          event.preventDefault();
          arrowPitch(-1, event.shiftKey);
          return;
        case "-":
        case "_":
          event.preventDefault();
          accidentalOnFocus(-1);
          return;
        case "=":
        case "+":
          event.preventDefault();
          accidentalOnFocus(1);
          return;
        case "0":
          event.preventDefault();
          accidentalOnFocus(0);
          return;
        default:
          break;
      }

      const upper = key.length === 1 ? key.toUpperCase() : "";
      if ("ABCDEFG".includes(upper)) {
        event.preventDefault();
        addLetter(upper as Pitch["step"]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    editable,
    listen,
    onListen,
    stepOut,
    drillIn,
    cycleChord,
    deleteSelection,
    navBeat,
    arrowPitch,
    accidentalOnFocus,
    addLetter,
    undo,
    redo,
  ]);

  const onImport = useCallback(
    async (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) {
        return;
      }
      let imported: string | null;
      // Provenance method for the conversions; native MusicXML/MXL is left
      // unstamped so a faithful file round-trips byte-for-byte.
      let importMethod: "optical-music-recognition" | "midi-conversion" | null =
        null;
      if (isImportableImage(file)) {
        imported = await imageImport.importImage(file);
        importMethod = "optical-music-recognition";
      } else if (isMxl(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        imported = await extractMusicXmlFromMxl(bytes);
      } else if (isMidi(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseMidi(bytes);
        const trackIndices = getMidiTracks(parsed).map((t) => t.index);
        imported = midiToMusicXmlWithTracks(parsed, trackIndices);
        importMethod = "midi-conversion";
      } else {
        imported = await file.text();
      }
      if (imported === null) {
        return;
      }
      const doc = parseDocument(imported);
      // Stamp how/when/from-what the document was imported (conversions only).
      if (importMethod) {
        stampImportProvenance(doc, {
          method: importMethod,
          sourceFile: file.name,
        });
      }
      history.reset(doc);
      setSelection(null);
      setMenu(null);
    },
    [history, imageImport],
  );

  const onExport = useCallback(() => {
    const blob = new Blob([musicxml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "score.musicxml";
    anchor.click();
    URL.revokeObjectURL(url);
    history.markSaved();
  }, [history, musicxml]);

  // Context-menu items act on the current selection.
  const canNudge = focused !== null;
  const canDelete = hasSelection && (slotInfo ? !slotInfo.isRest : true);
  const menuItems: ContextMenuItem[] = [
    {
      label: "Move up",
      onSelect: () => {
        if (focused) {
          stepHandle(focused, 1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Move down",
      onSelect: () => {
        if (focused) {
          stepHandle(focused, -1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Add note",
      onSelect: () => addNoteAtSlot(),
      disabled: !slotInfo,
    },
    { label: "Delete", onSelect: deleteSelection, disabled: !canDelete },
  ];

  // Accidental toolbar buttons act on the drilled note.
  const accidentalButtonStyle = (enabled: boolean) =>
    ({
      width: 30,
      height: 28,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: RADIUS.button,
      border: `1px solid ${COLORS.borderButton}`,
      background: COLORS.canvas,
      color: enabled ? COLORS.textPrimary : COLORS.textPlaceholder,
      cursor: enabled ? "pointer" : "default",
      fontFamily: FONTS.music,
      fontSize: 15,
    }) as const;

  const selectionReadout = slotInfo
    ? slotInfo.isRest
      ? `Sel: m.${slotInfo.measureIndex + 1} · rest`
      : `Sel: m.${slotInfo.measureIndex + 1} · ${slotInfo.notes.length} ${
          slotInfo.notes.length === 1 ? "note" : "notes"
        }`
    : "No selection";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        fontFamily: FONTS.ui,
        background: COLORS.appBg,
        color: COLORS.textPrimary,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          minHeight: LAYOUT.toolbarHeight,
          padding: "0 12px",
          background: COLORS.panel,
          borderBottom: `1px solid ${COLORS.borderLight}`,
          flexWrap: "wrap",
        }}
      >
        <label style={toolbarButtonStyle(!imageImport.busy)}>
          Import
          <input
            type="file"
            accept=".musicxml,.xml,.mxl,.mid,.midi,audio/midi,.pdf,image/*"
            onChange={onImport}
            disabled={imageImport.busy}
            style={{ display: "none" }}
          />
        </label>
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        <button
          type="button"
          onClick={undo}
          disabled={!history.canUndo}
          style={toolbarButtonStyle(history.canUndo)}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!history.canRedo}
          style={toolbarButtonStyle(history.canRedo)}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={deleteSelection}
          disabled={!canDelete}
          style={toolbarButtonStyle(hasSelection)}
        >
          Delete
        </button>
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        {(
          [
            { glyph: "♭", value: -1, title: "Flat" },
            { glyph: "♮", value: 0, title: "Natural" },
            { glyph: "♯", value: 1, title: "Sharp" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.title}
            onClick={() => accidentalOnFocus(option.value)}
            disabled={!canNudge}
            style={accidentalButtonStyle(canNudge)}
          >
            {option.glyph}
          </button>
        ))}
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        <button
          type="button"
          onClick={onInsertMeasure}
          disabled={!editable}
          style={toolbarButtonStyle(editable)}
        >
          + Measure
        </button>
        <span style={{ flex: 1 }} />
        {dirty ? (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: COLORS.warning,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: COLORS.warningDot,
              }}
            />
            Unsaved
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setMetadataOpen(true)}
          style={toolbarButtonStyle(true)}
        >
          Metadata
        </button>
        <button
          type="button"
          onClick={onExport}
          style={toolbarButtonStyle(true)}
        >
          Export
        </button>
        <button
          type="button"
          onClick={onListen}
          style={{
            padding: "6px 14px",
            borderRadius: RADIUS.button,
            border: "none",
            background: listen.playing ? COLORS.green : COLORS.accent,
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: FONTS.ui,
          }}
        >
          {listen.playing ? "■ Stop" : "▶ Listen"}
        </button>
      </div>

      {/* Instruction strip — keyboard cheat sheet. */}
      <div
        style={{
          minHeight: LAYOUT.instructionStripHeight,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          background: COLORS.instructionStrip,
          borderBottom: `1px solid ${COLORS.borderLight}`,
          fontFamily: FONTS.mono,
          fontSize: 11.5,
          color: COLORS.textSecondary,
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span>Click: select beat</span>
        <span>Enter: drill in · Esc: out</span>
        <span>↑↓: pitch (⇧ octave)</span>
        <span>←→: beat · Tab: cycle</span>
        <span>A–G: add · −/=/0: ♭♯♮</span>
        <span>Space: listen</span>
      </div>

      {/* Import status / error. */}
      {imageImport.status !== null ? (
        <div
          style={{
            fontSize: 13,
            color: COLORS.textSecondary,
            padding: "4px 14px",
          }}
        >
          {imageImport.status}
        </div>
      ) : null}
      {imageImport.error !== null ? (
        <div style={{ fontSize: 13, color: COLORS.error, padding: "4px 14px" }}>
          Import failed: {imageImport.error}
        </div>
      ) : null}

      {/* Body: score canvas + inspector. */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            background: COLORS.canvas,
            boxSizing: "border-box",
          }}
        >
          <ScoreHeader
            metadata={metadata}
            onEdit={() => setMetadataOpen(true)}
          />
          {/* A pointer-down that lands off the staff SVG (the empty canvas
              around/below the staves) clears the selection. Taps that reach the
              SVG keep their svg ancestor and are handled by handleTap instead. */}
          <div
            style={{ flex: 1, minHeight: 0, padding: 8 }}
            onPointerDown={(event) => {
              const target = event.target as Element | null;
              if (target && !target.closest("svg")) {
                setSelection(null);
                setMenu(null);
              }
            }}
          >
            <EditableSheetMusic
              musicxml={musicxml}
              noteHighlights={noteHighlights}
              onTap={handleTap}
              onContextMenu={handleContextMenu}
              accentColor={COLORS.accent}
              getLiveBeat={listen.getLiveBeat}
              isPlaying={listen.playing}
              scrollLocked={listen.playing}
              selectionBeat={selectionBeat}
              focusNoteId={focusNoteId}
            />
          </div>
        </div>
        <Inspector
          model={inspector?.model ?? null}
          editable={editable}
          onDrill={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setSelection({ kind: "note", handle });
            }
          }}
          onAccidental={(index, alter) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setAccidentalOn(handle, alter);
            }
          }}
          onStep={(index, delta) => {
            const handle = inspector?.handles[index];
            if (handle) {
              stepHandle(handle, delta, false);
            }
          }}
          onRemove={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              removeHandle(handle);
            }
          }}
          onSetDuration={(index, durationBeats) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setDurationOn(handle, durationBeats);
            }
          }}
          onAddNote={(partIndex) => {
            const targetSlot = inspector?.allSlots.find(
              (s) => s.partIndex === partIndex,
            );
            // When the target staff's covering slot started before the selected
            // beat (e.g. a whole rest at beat 0 while beat 1 is selected), pass
            // the selected beat so the note lands at the right rhythmic position.
            addNoteAtSlot(undefined, targetSlot, slotInfo?.onsetBeat);
          }}
          onGraceAccidental={(index, alter) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              setGraceAccidentalOn(handle, alter);
            }
          }}
          onGraceStep={(index, delta) => {
            const handle = inspector?.graceHandles[index];
            const pitch = inspector?.gracePitches[index];
            if (handle && pitch) {
              stepGraceHandle(handle, pitch, delta);
            }
          }}
          onGraceRemove={(index) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              removeGraceHandle(handle);
            }
          }}
          onGraceReorder={(index, direction) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              reorderGraceHandle(handle, direction);
            }
          }}
          onGraceSlash={(index, slash) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              setGraceSlashOn(handle, slash);
            }
          }}
        />
      </div>

      {/* Transport bar. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          minHeight: 40,
          padding: "0 14px",
          background: COLORS.panel,
          borderTop: `1px solid ${COLORS.borderLight}`,
          fontFamily: FONTS.mono,
          fontSize: 12,
          color: COLORS.textMuted,
        }}
      >
        <button
          type="button"
          aria-label={listen.playing ? "Pause" : "Play"}
          onClick={onListen}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 14,
            color: listen.playing ? COLORS.green : COLORS.textSecondary,
          }}
        >
          {listen.playing ? "⏸" : "▶"}
        </button>
        <span>♩ = {bpm}</span>
        <span style={{ flex: 1 }} />
        <span>{selectionReadout}</span>
      </div>

      {menu && hasSelection ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {metadataOpen ? (
        <MetadataDialog
          metadata={metadata}
          editable={true}
          onSave={onSaveMetadata}
          onClose={() => setMetadataOpen(false)}
        />
      ) : null}
    </div>
  );
}
