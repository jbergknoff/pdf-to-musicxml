// Editor shell: owns the live MusicXML Document, the duration palette, the
// selection, and import/export. The Document is the source of truth (held in a
// ref); a `version` counter forces a re-render after each in-place mutation, and
// the serialized string is recomputed from it.
//
// Interaction is click-to-select, not drag-to-edit: a tap selects the chord at
// a beat, a second tap (or a tap on a note already in the selected chord)
// narrows to one note, a right-click / long-press opens a context menu, and the
// arrow keys nudge a focused note. A plain drag only scrolls the staff.

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import {
  type ContextMenuRequest,
  EditableSheetMusic,
  type EditorGesture,
} from "./components/EditableSheetMusic";
import {
  createBlankDocument,
  isEditableDocument,
  moveNote,
  type NoteHandle,
  parseDocument,
  removeNotes,
  serializeDocument,
} from "./dom-edit";
import {
  chordAtBeat,
  type ChordSelection,
  chordForHandle,
  idForHandle,
  locateBeat,
  pitchForHandle,
  stepPitch,
} from "./hit-test";
import {
  computeMeasureStartBeats,
  type NoteHighlight,
  parseScore,
} from "./sheet-music/index";
import { parseMidi } from "midi-file";
import { extractMusicXmlFromMxl } from "../../lib/mxl";
import {
  getMidiTracks,
  midiToMusicXmlWithTracks,
} from "../../lib/midi-to-musicxml";
import { useHistory } from "./use-history";
import { isImportableImage, useImageImport } from "./use-image-import";

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

// A focused single note draws stronger than the rest of its selected chord.
const FOCUS_COLOR = "#1976d2";
const CHORD_COLOR = "#90caf9";
// Arrow-key (and context-menu) horizontal nudge, in quarter-note beats.
const BEAT_STEP = 1;

// The current selection: either a whole chord (every note at one beat) or one
// focused note. Both follow their notes across edits via the stable handles.
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

function sameChord(a: ChordSelection, b: ChordSelection): boolean {
  return a.measureIndex === b.measureIndex && a.onsetBeat === b.onsetBeat;
}

// Shared style for the plain toolbar buttons (Undo/Redo/Delete), dimmed when
// disabled.
function toolbarButtonStyle(enabled: boolean) {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid #ccc",
    background: "#fff",
    color: enabled ? "#333" : "#aaa",
    cursor: enabled ? "pointer" : "default",
    fontSize: 14,
  } as const;
}

// The single note edits (nudge) act on: an explicitly focused note, or a chord
// that holds exactly one note. A multi-note chord has no unambiguous target.
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

export function Editor() {
  // Undo/redo + dirty tracking own the live document, the version counter, and
  // commit. The document is still mutated in place; commit snapshots it.
  const history = useHistory(createBlankDocument);
  const { documentRef, version, commit } = history;
  const [selection, setSelection] = useState<Selection>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
  // Multi-staff / multi-voice files are view-only: their notes carry no source
  // provenance to select by, and the single-voice ops would corrupt them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const editable = useMemo(
    () => isEditableDocument(documentRef.current),
    [version],
  );

  // Selection highlights are re-derived from handles each render (ids change as
  // notes are added/removed): the focused note draws strong, chord-mates light.
  const noteHighlights: NoteHighlight[] = useMemo(() => {
    if (!selection) {
      return [];
    }
    if (selection.kind === "note") {
      const id = idForHandle(score, selection.handle);
      return id ? [{ kind: "score", id, color: FOCUS_COLOR }] : [];
    }
    return selection.chord.handles
      .map((handle) => idForHandle(score, handle))
      .filter((id): id is string => id !== null)
      .map((id) => ({ kind: "score", id, color: CHORD_COLOR }));
  }, [selection, score]);

  const hasSelection = selection !== null;

  // Tap on the staff: select the chord at that beat, then narrow to one note on
  // a repeat tap. A tap on empty space clears the selection — it never inserts a
  // note (clicking the staff used to add, which made stray clicks destructive).
  const handleTap = useCallback(
    (gesture: EditorGesture) => {
      setMenu(null);
      // View-only documents: a tap must never select (there's no provenance to
      // select by) or otherwise act.
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
          (prev?.kind === "chord" && sameChord(prev.chord, chord)) ||
          (prev?.kind === "note" &&
            chord.handles.some((handle) => sameHandle(handle, prev.handle)));
        return alreadyHere
          ? { kind: "note", handle: picked }
          : { kind: "chord", chord };
      });
    },
    [editable, score],
  );

  // Right-click / long-press: select the chord at that beat (keeping a focused
  // note if it belongs to that chord) and open the menu at the pointer.
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

  // Move the focused note by a diatonic step (pitch) or a beat (onset). Used by
  // both the arrow keys and the context menu.
  const nudge = useCallback(
    (axis: "pitch" | "beat", delta: number) => {
      const handle = focusedHandle(selection);
      if (!handle) {
        return;
      }
      const doc = documentRef.current;
      const pitch = pitchForHandle(score, handle);
      const chord = chordForHandle(score, handle);
      if (!pitch || !chord) {
        return;
      }
      const measureStart = measureStartBeats[handle.measureIndex] ?? 0;
      const target =
        axis === "pitch"
          ? {
              measureIndex: handle.measureIndex,
              onsetBeatInMeasure: chord.onsetBeat - measureStart,
              pitch: stepPitch(pitch, delta),
            }
          : (() => {
              const newBeat = Math.max(0, chord.onsetBeat + delta * BEAT_STEP);
              const loc = locateBeat(newBeat, measureStartBeats);
              return { ...loc, pitch };
            })();
      const moved = moveNote(doc, handle, target);
      if (moved) {
        setSelection({ kind: "note", handle: moved });
        // Coalesce a rapid run of nudges into one undo entry.
        commit({ coalesce: "nudge" });
      }
    },
    [commit, documentRef, measureStartBeats, score, selection],
  );

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

  // Undo/redo also drop the selection + menu: the prior handles may no longer
  // resolve against the restored document.
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

  // Delete / Backspace removes the selection; arrow keys nudge a focused note;
  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes.
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
      switch (event.key) {
        case "Delete":
        case "Backspace":
          event.preventDefault();
          deleteSelection();
          break;
        case "ArrowUp":
          event.preventDefault();
          nudge("pitch", 1);
          break;
        case "ArrowDown":
          event.preventDefault();
          nudge("pitch", -1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          nudge("beat", -1);
          break;
        case "ArrowRight":
          event.preventDefault();
          nudge("beat", 1);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection, nudge, undo, redo]);

  const onImport = useCallback(
    async (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      // Reset the input up front so re-selecting the same file fires `change`
      // again, even though the recognition below is async.
      input.value = "";
      if (!file) {
        return;
      }
      // Route by file type: images/PDFs through OMR, .mxl via ZIP extraction,
      // MIDI via conversion, and MusicXML/.xml read as plain text.
      let musicxml: string | null;
      if (isImportableImage(file)) {
        musicxml = await imageImport.importImage(file);
      } else if (isMxl(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        musicxml = await extractMusicXmlFromMxl(bytes);
      } else if (isMidi(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseMidi(bytes);
        const trackIndices = getMidiTracks(parsed).map((t) => t.index);
        musicxml = midiToMusicXmlWithTracks(parsed, trackIndices);
      } else {
        musicxml = await file.text();
      }
      if (musicxml === null) {
        return;
      }
      // A fresh load resets history and the dirty baseline to the import.
      history.reset(parseDocument(musicxml));
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
    // The on-disk file now matches the document: clear the dirty marker.
    history.markSaved();
  }, [history, musicxml]);

  // Items depend on the selection: nudges need an unambiguous focused note.
  const canNudge = focusedHandle(selection) !== null;
  const menuItems: ContextMenuItem[] = [
    {
      label: "Move up",
      onSelect: () => nudge("pitch", 1),
      disabled: !canNudge,
    },
    {
      label: "Move down",
      onSelect: () => nudge("pitch", -1),
      disabled: !canNudge,
    },
    {
      label: "Move left",
      onSelect: () => nudge("beat", -1),
      disabled: !canNudge,
    },
    {
      label: "Move right",
      onSelect: () => nudge("beat", 1),
      disabled: !canNudge,
    },
    { label: "Delete", onSelect: deleteSelection, disabled: !hasSelection },
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        height: "100%",
        boxSizing: "border-box",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
              color: "#8a6d3b",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#f59e0b",
              }}
            />
            Unsaved
          </span>
        ) : null}
        <label
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #ccc",
            background: "#fff",
            cursor: imageImport.busy ? "default" : "pointer",
            color: imageImport.busy ? "#aaa" : "#333",
            fontSize: 14,
          }}
        >
          Import
          <input
            type="file"
            accept=".musicxml,.xml,.mxl,.mid,.midi,audio/midi,.pdf,image/*"
            onChange={onImport}
            disabled={imageImport.busy}
            style={{ display: "none" }}
          />
        </label>
        <button
          type="button"
          onClick={onExport}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #ccc",
            background: "#fff",
            color: "#333",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          Export
        </button>
      </div>
      {imageImport.status !== null ? (
        <div style={{ fontSize: 13, color: "#555" }}>{imageImport.status}</div>
      ) : null}
      {imageImport.error !== null ? (
        <div style={{ fontSize: 13, color: "#c62828" }}>
          Import failed: {imageImport.error}
        </div>
      ) : null}
      {!editable ? (
        <div
          style={{
            fontSize: 13,
            color: "#8a6d3b",
            background: "#fff8e1",
            border: "1px solid #f0e0a0",
            borderRadius: 6,
            padding: "6px 10px",
          }}
        >
          This score uses multiple staves or voices, which the editor can't edit
          yet — it's view-only. Editing tools are disabled.
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        <EditableSheetMusic
          musicxml={musicxml}
          noteHighlights={noteHighlights}
          onTap={handleTap}
          onContextMenu={handleContextMenu}
        />
      </div>
      {menu && hasSelection ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
