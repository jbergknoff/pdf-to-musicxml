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
import { Inspector, type InspectorModel } from "./components/Inspector";
import { MetadataDialog } from "./components/MetadataDialog";
import { ScoreHeader } from "./components/ScoreHeader";
import {
  type EditableMetadata,
  readMetadata,
  stampImportProvenance,
  writeMetadata,
} from "./metadata";
import {
  addNoteToChord,
  createBlankDocument,
  insertMeasure,
  isEditableDocument,
  moveNote,
  type NoteHandle,
  parseDocument,
  removeNotes,
  serializeDocument,
  setAccidental,
} from "./dom-edit";
import {
  chordAtBeat,
  type ChordSelection,
  chordForHandle,
  type ChordInfo,
  chordInfoForHandle,
  chordInfos,
  idForHandle,
  octavePitch,
  pitchForHandle,
  stepPitch,
  topFirstNotes,
} from "./hit-test";
import {
  computeMeasureStartBeats,
  type NoteHighlight,
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

// The current selection: either a whole chord (Level 1) or one focused note
// (Level 2). Both follow their notes across edits via the stable handles.
type Selection =
  | { kind: "chord"; chord: ChordSelection }
  | { kind: "note"; handle: NoteHandle }
  | null;

function sameHandle(a: NoteHandle, b: NoteHandle): boolean {
  return (
    a.measureIndex === b.measureIndex &&
    a.noteElementIndex === b.noteElementIndex
  );
}

// The single-note target for nudges/accidentals: an explicitly focused note, or
// a chord that holds exactly one note.
function focusedHandle(selection: Selection): NoteHandle | null {
  if (!selection) {
    return null;
  }
  if (selection.kind === "note") {
    return selection.handle;
  }
  return selection.chord.handles.length === 1
    ? selection.chord.handles[0]
    : null;
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

  const listen = useListen(score);

  // The rich chord info for the current selection (notes + duration type).
  const chordInfo: ChordInfo | null = useMemo(() => {
    if (!selection) {
      return null;
    }
    const handle =
      selection.kind === "note" ? selection.handle : selection.chord.handles[0];
    return handle ? chordInfoForHandle(score, handle) : null;
  }, [selection, score]);

  // The inspector model + the parallel top-first handle list it indexes into.
  const inspector = useMemo<{
    model: InspectorModel;
    handles: NoteHandle[];
  } | null>(() => {
    if (!chordInfo) {
      return null;
    }
    const rows = topFirstNotes(chordInfo);
    const focused = focusedHandle(selection);
    const measureStart = measureStartBeats[chordInfo.measureIndex] ?? 0;
    const beatType = score.parts[0]?.timeSig?.beatType ?? 4;
    const beatNumber =
      Math.round((chordInfo.onsetBeat - measureStart) * (beatType / 4)) + 1;
    return {
      model: {
        level: selection?.kind === "note" ? "note" : "beat",
        measureNumber: chordInfo.measureIndex + 1,
        beatNumber,
        durationLabel: chordInfo.type,
        notes: rows.map((row) => ({
          key: row.id,
          label: pitchLabel(row.pitch),
          alter: row.pitch.alter,
          focused: focused ? sameHandle(row.handle, focused) : false,
        })),
      },
      handles: rows.map((row) => row.handle),
    };
  }, [chordInfo, selection, score, measureStartBeats]);

  // Selection highlights: the focused note draws strong, chord-mates light.
  const noteHighlights: NoteHighlight[] = useMemo(() => {
    if (!selection) {
      return [];
    }
    if (selection.kind === "note") {
      if (chordInfo) {
        const out: NoteHighlight[] = [];
        for (const note of chordInfo.notes) {
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
      const id = idForHandle(score, selection.handle);
      return id ? [{ kind: "score", id, color: FOCUS_COLOR }] : [];
    }
    return selection.chord.handles
      .map((handle) => idForHandle(score, handle))
      .filter((id): id is string => id !== null)
      .map((id) => ({ kind: "score", id, color: CHORD_TINT }));
  }, [selection, score, chordInfo]);

  const hasSelection = selection !== null;

  // Tap on the staff: select the chord at that beat, then narrow to one note on
  // a repeat tap (or a direct notehead tap). A tap on empty space clears the
  // selection — it never inserts a note.
  const handleTap = useCallback(
    (gesture: EditorGesture) => {
      setMenu(null);
      if (!editable) {
        return;
      }
      if (!gesture.hit) {
        setSelection(null);
        return;
      }
      const picked = gesture.hit.handle;
      const chord = chordForHandle(score, picked);
      if (!chord) {
        setSelection({ kind: "note", handle: picked });
        return;
      }
      setSelection((prev) => {
        const alreadyHere =
          (prev?.kind === "chord" &&
            prev.chord.measureIndex === chord.measureIndex &&
            prev.chord.onsetBeat === chord.onsetBeat) ||
          (prev?.kind === "note" &&
            chord.handles.some((handle) => sameHandle(handle, prev.handle)));
        return alreadyHere
          ? { kind: "note", handle: picked }
          : { kind: "chord", chord };
      });
    },
    [editable, score],
  );

  const handleContextMenu = useCallback(
    (request: ContextMenuRequest) => {
      if (!editable) {
        return;
      }
      const chord = chordAtBeat(score, request.beat);
      if (!chord) {
        setMenu(null);
        return;
      }
      setSelection((prev) => {
        if (
          prev?.kind === "note" &&
          chord.handles.some((handle) => sameHandle(handle, prev.handle))
        ) {
          return prev;
        }
        return { kind: "chord", chord };
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
      const moved = moveNote(documentRef.current, handle, {
        measureIndex: chord.measureIndex,
        onsetBeatInMeasure: chord.onsetBeat - measureStart,
        pitch: octave ? octavePitch(pitch, delta) : stepPitch(pitch, delta),
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

  const removeHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      removeNotes(documentRef.current, [handle]);
      setSelection(null);
      setMenu(null);
      commit();
    },
    [editable, documentRef, commit],
  );

  const addNoteToCurrent = useCallback(
    (pitch?: Pitch) => {
      if (!editable || !chordInfo) {
        return;
      }
      const added = addNoteToChord(
        documentRef.current,
        chordInfo.notes[0].handle,
        pitch,
      );
      if (added) {
        setSelection({ kind: "note", handle: added });
        commit();
      }
    },
    [editable, chordInfo, documentRef, commit],
  );

  const addLetter = useCallback(
    (step: Pitch["step"]) => {
      if (!chordInfo) {
        return;
      }
      const top = topFirstNotes(chordInfo)[0].pitch;
      addNoteToCurrent({ step, alter: 0, octave: top.octave });
    },
    [chordInfo, addNoteToCurrent],
  );

  const onInsertMeasure = useCallback(() => {
    if (!editable) {
      return;
    }
    insertMeasure(documentRef.current, chordInfo?.measureIndex);
    setSelection(null);
    setMenu(null);
    commit();
  }, [editable, chordInfo, documentRef, commit]);

  const deleteSelection = useCallback(() => {
    if (!selection) {
      return;
    }
    const handles =
      selection.kind === "note" ? [selection.handle] : selection.chord.handles;
    removeNotes(documentRef.current, handles);
    setSelection(null);
    setMenu(null);
    commit();
  }, [commit, documentRef, selection]);

  // ── Selection navigation (keyboard) ─────────────────────────────────────────

  const drillIn = useCallback(() => {
    setSelection((prev) => {
      if (prev?.kind !== "chord") {
        return prev;
      }
      const info = chordInfoForHandle(score, prev.chord.handles[0]);
      return info
        ? { kind: "note", handle: topFirstNotes(info)[0].handle }
        : prev;
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
            kind: "chord",
            chord: {
              measureIndex: info.measureIndex,
              onsetBeat: info.onsetBeat,
              handles: info.notes.map((note) => note.handle),
            },
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

  const navBeat = useCallback(
    (dir: number) => {
      const list = chordInfos(score);
      if (list.length === 0) {
        return;
      }
      setSelection((prev) => {
        let index: number;
        if (!prev) {
          index = dir > 0 ? 0 : list.length - 1;
        } else {
          const handle =
            prev.kind === "note" ? prev.handle : prev.chord.handles[0];
          const current = list.findIndex((info) =>
            info.notes.some((note) => sameHandle(note.handle, handle)),
          );
          index = current < 0 ? (dir > 0 ? 0 : list.length - 1) : current + dir;
        }
        if (index < 0 || index >= list.length) {
          return prev; // clamp at the ends
        }
        const next = list[index];
        if (prev?.kind === "note") {
          return { kind: "note", handle: topFirstNotes(next)[0].handle };
        }
        return {
          kind: "chord",
          chord: {
            measureIndex: next.measureIndex,
            onsetBeat: next.onsetBeat,
            handles: next.notes.map((note) => note.handle),
          },
        };
      });
    },
    [score],
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
      const handle = focusedHandle(selection);
      if (handle) {
        setAccidentalOn(handle, alter);
      }
    },
    [selection, setAccidentalOn],
  );

  const onListen = useCallback(() => {
    listen.toggle(chordInfo?.onsetBeat);
  }, [listen, chordInfo]);

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
  const canNudge = focusedHandle(selection) !== null;
  const menuItems: ContextMenuItem[] = [
    {
      label: "Move up",
      onSelect: () => {
        const handle = focusedHandle(selection);
        if (handle) {
          stepHandle(handle, 1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Move down",
      onSelect: () => {
        const handle = focusedHandle(selection);
        if (handle) {
          stepHandle(handle, -1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Add note",
      onSelect: () => addNoteToCurrent(),
      disabled: !chordInfo,
    },
    { label: "Delete", onSelect: deleteSelection, disabled: !hasSelection },
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

  const selectionReadout = chordInfo
    ? `Sel: m.${chordInfo.measureIndex + 1} · ${chordInfo.notes.length} ${
        chordInfo.notes.length === 1 ? "note" : "notes"
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
          disabled={!hasSelection}
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
          <div style={{ flex: 1, minHeight: 0, padding: 8 }}>
            <EditableSheetMusic
              musicxml={musicxml}
              noteHighlights={noteHighlights}
              onTap={handleTap}
              onContextMenu={handleContextMenu}
              accentColor={COLORS.accent}
              getLiveBeat={listen.getLiveBeat}
              isPlaying={listen.playing}
              scrollLocked={listen.playing}
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
          onAddNote={() => addNoteToCurrent()}
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
        <span>♩ = 100</span>
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
