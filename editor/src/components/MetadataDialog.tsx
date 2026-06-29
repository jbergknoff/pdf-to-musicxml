// A modal dialog for viewing and editing the score's metadata. The editable
// fields (title, composer, …) map one-to-one to standard MusicXML metadata
// elements; below them a read-only section surfaces the `<encoding>` and any
// `import-*` provenance the file carries, so a user can see how/when/from what
// the document was imported. The Editor owns the document — this is a pure form
// that hands its edited values back on Save.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { EditableMetadata, ScoreMetadata } from "../metadata";
import { COLORS, FONTS, RADIUS } from "../theme";

interface FieldSpec {
  key: keyof EditableMetadata;
  label: string;
  placeholder: string;
}

const FIELDS: FieldSpec[] = [
  { key: "workTitle", label: "Work title", placeholder: "e.g. Symphony No. 5" },
  {
    key: "movementTitle",
    label: "Movement title",
    placeholder: "e.g. I. Allegro con brio",
  },
  { key: "composer", label: "Composer", placeholder: "e.g. L. v. Beethoven" },
  { key: "lyricist", label: "Lyricist", placeholder: "" },
  { key: "arranger", label: "Arranger", placeholder: "" },
  { key: "rights", label: "Copyright", placeholder: "e.g. © 2026" },
  {
    key: "source",
    label: "Source",
    placeholder: "Where the music came from",
  },
];

// A friendlier label for the reserved import-provenance miscellaneous fields.
const MISC_LABELS: Record<string, string> = {
  "import-method": "Import method",
  "import-source-file": "Source file",
  "import-date": "Imported at",
};

function pickEditable(meta: ScoreMetadata): EditableMetadata {
  return {
    workTitle: meta.workTitle,
    movementTitle: meta.movementTitle,
    composer: meta.composer,
    lyricist: meta.lyricist,
    arranger: meta.arranger,
    rights: meta.rights,
    source: meta.source,
  };
}

export interface MetadataDialogProps {
  metadata: ScoreMetadata;
  editable: boolean;
  onSave: (values: EditableMetadata) => void;
  onClose: () => void;
}

export function MetadataDialog({
  metadata,
  editable,
  onSave,
  onClose,
}: MetadataDialogProps) {
  const [values, setValues] = useState<EditableMetadata>(() =>
    pickEditable(metadata),
  );
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Open as a true modal so the browser supplies the focus trap, ::backdrop,
  // and Esc-to-cancel for free. The native "cancel" event (Esc) routes to
  // onClose without saving.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog?.addEventListener("cancel", onCancel);
    return () => dialog?.removeEventListener("cancel", onCancel);
  }, [onClose]);

  const set = (key: keyof EditableMetadata, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // Read-only provenance lines: the encoding block plus any miscellaneous
  // fields the file carries.
  const provenance = useMemo(() => {
    const lines: Array<{ label: string; value: string }> = [];
    for (const software of metadata.encoding.software) {
      lines.push({ label: "Software", value: software });
    }
    if (metadata.encoding.encoder) {
      lines.push({ label: "Encoder", value: metadata.encoding.encoder });
    }
    if (metadata.encoding.encodingDate) {
      lines.push({ label: "Encoded", value: metadata.encoding.encodingDate });
    }
    if (metadata.encoding.encodingDescription) {
      lines.push({
        label: "Description",
        value: metadata.encoding.encodingDescription,
      });
    }
    for (const field of metadata.miscellaneous) {
      lines.push({
        label: MISC_LABELS[field.name] ?? field.name,
        value: field.value,
      });
    }
    return lines;
  }, [metadata]);

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontFamily: FONTS.mono,
    letterSpacing: ".04em",
    textTransform: "uppercase" as const,
    color: COLORS.textFaint,
    marginBottom: 4,
  };

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "7px 9px",
    fontSize: 13,
    fontFamily: FONTS.ui,
    color: COLORS.textPrimary,
    background: editable ? COLORS.canvas : COLORS.panel,
    border: `1px solid ${COLORS.borderButton}`,
    borderRadius: RADIUS.button,
  };

  return (
    // A click on the backdrop (the dialog itself, outside the padded content)
    // dismisses; keyboard close is the native Esc → "cancel" handled above.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc closes via the dialog cancel event
    <dialog
      ref={dialogRef}
      aria-label="Score metadata"
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
      style={{
        width: "100%",
        maxWidth: 460,
        padding: 0,
        margin: "auto",
        border: "none",
        background: "transparent",
        color: COLORS.textPrimary,
      }}
    >
      <div
        style={{
          background: COLORS.canvas,
          borderRadius: RADIUS.overlay,
          border: `1px solid ${COLORS.borderLight}`,
          boxShadow: "0 12px 40px rgba(0,0,0,0.22)",
          fontFamily: FONTS.ui,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <span
            style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}
          >
            Score metadata
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              color: COLORS.textMuted,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>

        {/* Editable fields */}
        <div
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {FIELDS.map((field) => (
            <label key={field.key}>
              <span style={labelStyle}>{field.label}</span>
              <input
                type="text"
                value={values[field.key]}
                placeholder={field.placeholder}
                disabled={!editable}
                onInput={(event) =>
                  set(
                    field.key,
                    (event.currentTarget as HTMLInputElement).value,
                  )
                }
                style={inputStyle}
              />
            </label>
          ))}

          {/* Read-only encoding / provenance */}
          {provenance.length > 0 ? (
            <div
              style={{
                marginTop: 4,
                paddingTop: 14,
                borderTop: `1px solid ${COLORS.borderLight}`,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontFamily: FONTS.mono,
                  letterSpacing: ".04em",
                  textTransform: "uppercase",
                  color: COLORS.textFaint,
                  marginBottom: 8,
                }}
              >
                Encoding &amp; provenance
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {provenance.map((line) => (
                  <div
                    key={`${line.label}:${line.value}`}
                    style={{ display: "flex", gap: 8, fontSize: 12 }}
                  >
                    <span
                      style={{
                        flex: "none",
                        width: 96,
                        color: COLORS.textMuted,
                      }}
                    >
                      {line.label}
                    </span>
                    <span
                      style={{
                        color: COLORS.textSecondary,
                        fontFamily: FONTS.mono,
                        wordBreak: "break-word",
                      }}
                    >
                      {line.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "7px 14px",
              borderRadius: RADIUS.button,
              border: `1px solid ${COLORS.borderButton}`,
              background: COLORS.canvas,
              color: COLORS.textPrimary,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: FONTS.ui,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!editable}
            onClick={() => onSave(values)}
            style={{
              padding: "7px 16px",
              borderRadius: RADIUS.button,
              border: "none",
              background: editable ? COLORS.accent : COLORS.borderButton,
              color: "#fff",
              cursor: editable ? "pointer" : "default",
              fontSize: 13,
              fontFamily: FONTS.ui,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}
