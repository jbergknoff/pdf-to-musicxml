import * as pdfjs from "pdfjs-dist";
import type { RgbaImage } from "../../lib/types";

/**
 * Decodes a user-supplied file into an {@link RgbaImage} for the pipeline.
 * Raster images go through `createImageBitmap`; PDFs are rasterized with pdf.js.
 * Everything runs locally — no upload.
 */

// pdf.js renders on a worker; the build copies the worker bundle to the site
// root (see scripts/build.ts).
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// Render PDF pages large enough that the smaller staff detail survives, then let
// preprocessing rescale into the model's pixel budget. ~2200 px on the long edge
// approximates a 300 DPI scan of a portrait page.
const PDF_TARGET_LONG_EDGE = 2200;

export function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

export async function decodeFile(file: File): Promise<RgbaImage> {
  if (isPdf(file)) {
    return renderPdfFirstPage(file);
  }
  return decodeRasterImage(file);
}

function readCanvas(canvas: HTMLCanvasElement): RgbaImage {
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Could not get a 2D canvas context");
  }
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  };
}

async function decodeRasterImage(file: File): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Could not get a 2D canvas context");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return readCanvas(canvas);
}

async function renderPdfFirstPage(file: File): Promise<RgbaImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document_ = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const page = await document_.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const scale =
      PDF_TARGET_LONG_EDGE / Math.max(unscaled.width, unscaled.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Could not get a 2D canvas context");
    }
    await page.render({ canvasContext: context, viewport }).promise;
    return readCanvas(canvas);
  } finally {
    await document_.destroy();
  }
}
