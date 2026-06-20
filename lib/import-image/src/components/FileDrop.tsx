import { useState } from "preact/hooks";

/**
 * Drop target / file picker for the input score. Accepts a PDF or a raster
 * image and hands the chosen `File` to the parent; it does no decoding itself.
 */

interface FileDropProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function FileDrop({ onFile, disabled }: FileDropProps) {
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    if (disabled) {
      return;
    }
    const file = files?.[0];
    if (file) {
      onFile(file);
    }
  }

  return (
    <label
      class={`file-drop${dragging ? " file-drop--active" : ""}${
        disabled ? " file-drop--disabled" : ""
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        handleFiles(event.dataTransfer?.files ?? null);
      }}
    >
      <input
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        disabled={disabled}
        onChange={(event) => {
          handleFiles((event.currentTarget as HTMLInputElement).files);
        }}
      />
      <span>Drop a PDF or image of sheet music, or click to choose</span>
    </label>
  );
}
