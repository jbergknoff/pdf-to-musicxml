// Lazily-created bridge to the OMR pipeline (lib/import-image): turns a dropped
// PDF/image file into MusicXML in the worker, exposing a small busy/status/error
// surface for the toolbar. The importer (and its worker + model weights) is
// created on first use and reused for subsequent imports.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createImageImporter,
  type ImageImporter,
  isPdf,
  type ProgressUpdate,
} from "../../lib/import-image/index";

/** Recognized image extensions, alongside PDF, that route through the OMR pipeline. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];

/** Whether a file should be recognized via OMR rather than parsed as MusicXML. */
export function isImportableImage(file: File): boolean {
  if (isPdf(file)) {
    return true;
  }
  if (file.type.startsWith("image/")) {
    return true;
  }
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Human-readable status line for a worker progress update. */
function describeProgress(update: ProgressUpdate): string {
  switch (update.phase) {
    case "loading-models": {
      return update.detail ? `Loading ${update.detail}…` : "Loading models…";
    }
    case "segmenting": {
      return `Segmenting… ${Math.round(update.fraction * 100)}%`;
    }
    case "detecting-staves": {
      return "Detecting staves…";
    }
    case "transcribing": {
      return `Transcribing… ${Math.round(update.fraction * 100)}%`;
    }
  }
}

export interface ImageImportState {
  busy: boolean;
  status: string | null;
  error: string | null;
  /** Recognize a file and return its MusicXML, or null on failure. */
  importImage(file: File): Promise<string | null>;
}

export function useImageImport(): ImageImportState {
  const importerRef = useRef<Promise<ImageImporter> | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tear the worker down when the editor unmounts.
  useEffect(() => {
    return () => {
      importerRef.current?.then((importer) => importer.dispose());
    };
  }, []);

  const importImage = useCallback(
    async (file: File): Promise<string | null> => {
      setBusy(true);
      setError(null);
      setStatus(`Decoding ${file.name}…`);
      try {
        if (importerRef.current === null) {
          importerRef.current = createImageImporter();
        }
        const importer = await importerRef.current;
        const musicxml = await importer.importFile(file, (update) => {
          setStatus(describeProgress(update));
        });
        if (musicxml === "") {
          setError("No staves were recognized in that file.");
          return null;
        }
        return musicxml;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return null;
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [],
  );

  return { busy, status, error, importImage };
}
