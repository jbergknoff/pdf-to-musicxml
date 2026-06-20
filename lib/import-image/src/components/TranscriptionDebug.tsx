import { useEffect, useRef } from "preact/hooks";
import { cropStaff } from "../../lib/transcription/staff-crop";
import type {
  NoteEvent,
  RgbaImage,
  Staff,
  Transcription,
} from "../../lib/types";

/** Render a staff crop canvas from the (segmentation-resolution) display image. */
function StaffCrop({
  image,
  staff,
}: {
  image: RgbaImage;
  staff: Staff;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const cropped = cropStaff(image, staff);
    canvas.width = cropped.width;
    canvas.height = cropped.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    const imageData = new ImageData(
      new Uint8ClampedArray(cropped.data.buffer as ArrayBuffer),
      cropped.width,
      cropped.height,
    );
    context.putImageData(imageData, 0, 0);
  }, [image, staff]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", maxWidth: "100%", border: "1px solid #ccc" }}
    />
  );
}

function noteLabel(note: NoteEvent): string {
  const acc =
    note.accidental === "sharp"
      ? "#"
      : note.accidental === "flat"
        ? "b"
        : note.accidental === "natural"
          ? "♮"
          : note.accidental === "double_sharp"
            ? "##"
            : note.accidental === "double_flat"
              ? "bb"
              : "";
  const pitch = note.pitch === "rest" ? "rest" : `${note.pitch}${acc}`;
  const dur =
    note.duration === "whole"
      ? "1"
      : note.duration === "half"
        ? "2"
        : note.duration === "quarter"
          ? "4"
          : note.duration === "eighth"
            ? "8"
            : note.duration === "sixteenth"
              ? "16"
              : "32";
  return `${pitch}/${dur}${note.dotted ? "." : ""}`;
}

function StaffDebug({
  index,
  staff,
  transcription,
  image,
}: {
  index: number;
  staff: Staff;
  transcription: Transcription;
  image: RgbaImage;
}) {
  return (
    <details style={{ marginBottom: "1rem" }}>
      <summary style={{ cursor: "pointer", fontWeight: "bold" }}>
        Staff {index + 1} — {transcription.rawRhythm.length} tokens,{" "}
        {transcription.notes.length} notes, {transcription.measureCount}{" "}
        measures
      </summary>
      <div style={{ marginTop: "0.5rem" }}>
        <StaffCrop image={image} staff={staff} />
        <p
          style={{
            fontSize: "0.75rem",
            fontFamily: "monospace",
            margin: "0.5rem 0",
            wordBreak: "break-all",
          }}
        >
          <strong>Rhythm tokens:</strong> {transcription.rawRhythm.join(" · ")}
        </p>
        <p
          style={{
            fontSize: "0.75rem",
            fontFamily: "monospace",
            margin: "0.5rem 0",
            wordBreak: "break-all",
          }}
        >
          <strong>Notes:</strong>{" "}
          {transcription.notes.length === 0
            ? "(none)"
            : transcription.notes.map(noteLabel).join(" ")}
        </p>
      </div>
    </details>
  );
}

export function TranscriptionDebug({
  image,
  staves,
  transcriptions,
}: {
  image: RgbaImage;
  staves: Staff[];
  transcriptions: Transcription[];
}) {
  if (transcriptions.length === 0) {
    return null;
  }
  return (
    <section style={{ padding: "1rem", borderTop: "1px solid #ddd" }}>
      <h2 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
        Transcription debug ({transcriptions.length} staves)
      </h2>
      {transcriptions.map((t, i) => (
        <StaffDebug
          // biome-ignore lint/suspicious/noArrayIndexKey: staves are ordered and stable
          key={i}
          index={i}
          staff={staves[i]}
          transcription={t}
          image={image}
        />
      ))}
    </section>
  );
}
