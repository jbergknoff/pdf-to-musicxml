// A compact title band above the score: the work / movement title and the
// composer (and arranger), engraved-style — centered title, attribution below.
// The whole band is a button that opens the metadata dialog, so the header
// doubles as the affordance for editing it. When nothing is set it shows a faint
// "Untitled score" prompt instead.

import type { ScoreMetadata } from "../metadata";
import { COLORS, FONTS } from "../theme";

// "Work — Movement", dropping a movement title that just repeats the work title.
function titleOf(metadata: ScoreMetadata): string {
  const parts: string[] = [];
  if (metadata.workTitle) {
    parts.push(metadata.workTitle);
  }
  if (metadata.movementTitle && metadata.movementTitle !== metadata.workTitle) {
    parts.push(metadata.movementTitle);
  }
  return parts.join(" — ");
}

// "Composer · arr. Arranger" from whichever attributions are present.
function attributionOf(metadata: ScoreMetadata): string {
  const parts: string[] = [];
  if (metadata.composer) {
    parts.push(metadata.composer);
  }
  if (metadata.arranger) {
    parts.push(`arr. ${metadata.arranger}`);
  }
  return parts.join(" · ");
}

export function ScoreHeader({
  metadata,
  onEdit,
}: {
  metadata: ScoreMetadata;
  onEdit: () => void;
}) {
  const title = titleOf(metadata);
  const attribution = attributionOf(metadata);
  const empty = !title && !attribution;

  return (
    <button
      type="button"
      onClick={onEdit}
      title="Edit score metadata"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        width: "100%",
        padding: "6px 12px 8px",
        border: "none",
        borderBottom: `1px solid ${COLORS.borderLight}`,
        background: "transparent",
        cursor: "pointer",
        fontFamily: FONTS.ui,
      }}
    >
      {empty ? (
        <span style={{ fontSize: 14, color: COLORS.textPlaceholder }}>
          Untitled score
        </span>
      ) : (
        <>
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: title ? COLORS.textPrimary : COLORS.textPlaceholder,
              textAlign: "center",
              lineHeight: 1.2,
            }}
          >
            {title || "Untitled"}
          </span>
          {attribution ? (
            <span style={{ fontSize: 12.5, color: COLORS.textMuted }}>
              {attribution}
            </span>
          ) : null}
        </>
      )}
    </button>
  );
}
