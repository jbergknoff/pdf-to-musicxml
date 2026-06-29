// Wraps the vendored read-only renderer and adds the editing pointer seam.
// It holds no document: it resolves each raw pointer gesture from the staff SVG
// into a musical `{ beat, pitch, hit }` (via hit-test) and reports it up to the
// Editor, which owns the document and applies the dom-edit op. Visual feedback
// is drawn through the renderer's existing `noteHighlights` prop.
//
// Interaction model (foundation milestone): a primary-button tap reports a
// gesture (the Editor selects, or adds on empty staff); a plain drag is left
// uncaptured so it falls through to the renderer's drag-to-scroll; a
// right-click / long-press reports a context-menu request. Dragging never edits.

import type { NoteHandle } from "../dom-edit";
import { beatFromX, pickNote, pitchFromY } from "../hit-test";
import {
  type NoteHighlight,
  type Pitch,
  SheetMusicDisplay,
  type StagePointerInfo,
} from "../sheet-music/index";

export interface EditorGesture {
  /** Absolute quarter-note beat, snapped to the 16th-note grid. */
  beat: number;
  /** Pitch under the pointer, snapped to the nearest half staff-space. */
  pitch: Pitch;
  /** The note the pointer is over, if any (id for highlight, handle for edits). */
  hit: { id: string; handle: NoteHandle } | null;
}

/** A right-click / long-press request: a beat (and 1-indexed measure) plus the
 *  viewport coordinates to anchor a context menu at. */
export interface ContextMenuRequest {
  measureNumber: number;
  beat: number;
  clientX: number;
  clientY: number;
}

function resolveGesture(info: StagePointerInfo): EditorGesture {
  const beat = beatFromX(
    info.svgX,
    info.score,
    info.layout,
    info.measureStartBeats,
  );
  // Step 1 edits the single (first) staff.
  const clef = info.score.parts[0]?.clef ?? { sign: "G" as const, line: 2 };
  const staffBottomY = info.layout.staffBottomYs[0] ?? 0;
  const pitch = pitchFromY(
    info.svgY,
    staffBottomY,
    info.layout.staffSpace,
    clef,
  );
  return { beat, pitch, hit: pickNote(info.score, beat, pitch) };
}

export function EditableSheetMusic({
  musicxml,
  noteHighlights,
  onTap,
  onContextMenu,
  accentColor,
  textFontFamily = "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  getLiveBeat,
  isPlaying,
  scrollLocked,
}: {
  musicxml: string;
  noteHighlights?: ReadonlyArray<NoteHighlight>;
  /** Primary-button tap on the staff (a non-drag). */
  onTap?: (gesture: EditorGesture, event: PointerEvent) => void;
  /** Right-click / long-press on the staff. */
  onContextMenu?: (request: ContextMenuRequest) => void;
  /** Accent color for the playback cursor (and any selection chrome). */
  accentColor?: string;
  /** Font family for measure numbers. */
  textFontFamily?: string;
  /** Playback cursor beat source (drives the on-score cursor + scroll-follow). */
  getLiveBeat?: () => number | null;
  /** Whether playback is active (runs the cursor rAF loop). */
  isPlaying?: boolean;
  /** Disable user scroll while playing. */
  scrollLocked?: boolean;
}) {
  return (
    <SheetMusicDisplay
      musicxml={musicxml}
      noteHighlights={noteHighlights}
      accentColor={accentColor}
      textFontFamily={textFontFamily}
      getLiveBeat={getLiveBeat}
      isPlaying={isPlaying}
      scrollLocked={scrollLocked}
      // Allow horizontal pan: a plain drag scrolls rather than edits.
      containerStyle={{ touchAction: "pan-x", height: "100%" }}
      // Leave the pointer uncaptured so a drag reaches the container's
      // drag-to-scroll; we only act on the (primary-button) down as a tap.
      captureStagePointer={false}
      onStagePointerDown={(info, event) => {
        // Ignore non-primary buttons here — right-click is handled by the
        // context-menu seam, which also fires its own pointerdown.
        if (event.button !== 0) {
          return;
        }
        onTap?.(resolveGesture(info), event);
      }}
      onSheetContextMenu={onContextMenu}
    />
  );
}
