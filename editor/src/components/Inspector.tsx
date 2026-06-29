// The right-hand inspector: the touch-friendly counterpart to keyboard editing.
// It mirrors the current selection — a header naming the time-position and a
// per-note list for the selected chord, each row carrying an accidental
// segmented control, pitch steppers, and a remove button — plus an Add-note
// button. The drilled note's row is highlighted to stay in lock-step with the
// score. It is a pure view: the Editor owns the document and the index→handle
// mapping, and passes the model + callbacks down.

import { COLORS, FOCUS_SHADOW, FONTS, LAYOUT, RADIUS } from "../theme";

export type InspectorLevel = "idle" | "beat" | "note";

export interface InspectorNoteRow {
  /** Stable key for the row (the renderer note id). */
  key: string;
  /** Display label, e.g. "G4" or "F♯5". */
  label: string;
  /** Chromatic alteration: -1 flat, 0 natural, +1 sharp (±2 doubles). */
  alter: number;
  /** Whether this row is the drilled (Level 2) note. */
  focused: boolean;
}

export interface InspectorModel {
  level: InspectorLevel;
  measureNumber: number;
  beatNumber: number;
  /** Note-value name, e.g. "quarter". */
  durationLabel: string;
  /** Top-first (descending pitch) note rows; empty for a rest. */
  notes: InspectorNoteRow[];
}

const LEVEL_LABEL: Record<InspectorLevel, string> = {
  idle: "Idle",
  beat: "Beat",
  note: "Note",
};

function LevelBadge({ level }: { level: InspectorLevel }) {
  const active = level !== "idle";
  return (
    <span
      style={{
        fontFamily: FONTS.mono,
        fontSize: 10.5,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: active ? COLORS.accent : COLORS.textFaint,
        border: `1px solid ${active ? COLORS.accent : COLORS.borderLight}`,
        borderRadius: 5,
        padding: "2px 7px",
      }}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

// The ♭ ♮ ♯ segmented control. The applied accidental highlights in accent;
// ♮ is the neutral default and is not highlighted (matching the score, which
// only prints a natural when one is actually needed).
function AccidentalControl({
  alter,
  onSet,
}: {
  alter: number;
  onSet: (alter: number) => void;
}) {
  const options: Array<{ glyph: string; value: number }> = [
    { glyph: "♭", value: -1 },
    { glyph: "♮", value: 0 },
    { glyph: "♯", value: 1 },
  ];
  return (
    <span
      style={{
        display: "inline-flex",
        border: `1px solid ${COLORS.borderLight}`,
        borderRadius: 5,
        overflow: "hidden",
        fontFamily: FONTS.music,
        fontSize: 13,
      }}
    >
      {options.map((option, index) => {
        const applied =
          option.value < 0 ? alter < 0 : option.value > 0 ? alter > 0 : false;
        return (
          <button
            key={option.value}
            type="button"
            title={
              option.value < 0 ? "Flat" : option.value > 0 ? "Sharp" : "Natural"
            }
            onClick={() => onSet(option.value)}
            style={{
              padding: "2px 7px",
              border: "none",
              borderLeft:
                index === 0 ? "none" : `1px solid ${COLORS.borderLight}`,
              background: applied ? COLORS.accent : "transparent",
              color: applied ? "#fff" : COLORS.textPlaceholder,
              cursor: "pointer",
              lineHeight: 1.4,
            }}
          >
            {option.glyph}
          </button>
        );
      })}
    </span>
  );
}

function Stepper({ onStep }: { onStep: (delta: number) => void }) {
  const arrowStyle = {
    border: "none",
    background: "transparent",
    color: COLORS.textFaint,
    cursor: "pointer",
    fontSize: 9,
    lineHeight: 0.85,
    padding: 0,
  } as const;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column" }}>
      <button
        type="button"
        title="Up one step"
        onClick={() => onStep(1)}
        style={arrowStyle}
      >
        ▲
      </button>
      <button
        type="button"
        title="Down one step"
        onClick={() => onStep(-1)}
        style={arrowStyle}
      >
        ▼
      </button>
    </span>
  );
}

export interface InspectorProps {
  model: InspectorModel | null;
  /** Drill to (or focus) the note at this top-first index. */
  onDrill: (index: number) => void;
  onAccidental: (index: number, alter: number) => void;
  /** Staff-step the note: delta +1 up, -1 down. */
  onStep: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  onAddNote: () => void;
  /** When false the panel renders a view-only notice instead of controls. */
  editable: boolean;
}

export function Inspector({
  model,
  onDrill,
  onAccidental,
  onStep,
  onRemove,
  onAddNote,
  editable,
}: InspectorProps) {
  const subtitle =
    model && model.notes.length > 0
      ? `${model.notes.length} ${
          model.notes.length === 1 ? "note" : "notes"
        } · ${model.durationLabel}`
      : model
        ? `Rest · ${model.durationLabel}`
        : "";

  return (
    <aside
      style={{
        width: LAYOUT.inspectorWidth,
        flex: "none",
        background: COLORS.panel,
        borderLeft: `1px solid ${COLORS.borderLight}`,
        padding: 16,
        overflowY: "auto",
        boxSizing: "border-box",
        fontFamily: FONTS.ui,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.mono,
            fontSize: 10.5,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: COLORS.textFaint,
          }}
        >
          Selection
        </span>
        <LevelBadge level={model?.level ?? "idle"} />
      </div>

      {!editable ? (
        <p style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5 }}>
          This score uses multiple staves or voices — it's view-only. Editing
          tools are disabled.
        </p>
      ) : !model ? (
        <p
          style={{
            fontSize: 13,
            color: COLORS.textPlaceholder,
            lineHeight: 1.5,
            textAlign: "center",
            marginTop: 40,
          }}
        >
          Click a beat on the score to select it.
        </p>
      ) : (
        <>
          <div
            style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary }}
          >
            Measure {model.measureNumber} · Beat {model.beatNumber}
          </div>
          <div
            style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 14 }}
          >
            {subtitle}
          </div>

          {model.notes.length === 0 ? null : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {model.notes.map((note, index) => (
                <div
                  key={note.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    background: COLORS.canvas,
                    border: `${note.focused ? 1.5 : 1}px solid ${
                      note.focused ? COLORS.accent : COLORS.borderLight
                    }`,
                    borderRadius: RADIUS.row,
                    padding: "7px 8px",
                    boxShadow: note.focused ? FOCUS_SHADOW : undefined,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      flex: "none",
                      background: note.focused
                        ? COLORS.accent
                        : COLORS.textPrimary,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => onDrill(index)}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      fontFamily: FONTS.mono,
                      fontSize: 13,
                      fontWeight: note.focused ? 600 : 500,
                      color: note.focused ? COLORS.accent : COLORS.textPrimary,
                    }}
                  >
                    {note.label}
                  </button>
                  <AccidentalControl
                    alter={note.alter}
                    onSet={(alter) => onAccidental(index, alter)}
                  />
                  <Stepper onStep={(delta) => onStep(index, delta)} />
                  <button
                    type="button"
                    title="Remove note"
                    onClick={() => onRemove(index)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: COLORS.textPlaceholder,
                      cursor: "pointer",
                      fontSize: 13,
                      flex: "none",
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={onAddNote}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%",
              marginTop: 10,
              border: `1px dashed ${COLORS.accentBorderFaint}`,
              color: COLORS.accent,
              background: "transparent",
              borderRadius: RADIUS.row,
              padding: 8,
              fontSize: 12.5,
              fontFamily: FONTS.mono,
              cursor: "pointer",
            }}
          >
            + Add note
          </button>
        </>
      )}
    </aside>
  );
}
