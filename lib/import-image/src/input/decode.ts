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

/**
 * Decode a file into one raster per page: every page of a multi-page PDF, or a
 * single-element array for a raster image. The recognition pipeline runs once
 * per page and the results are concatenated, so a multi-page score round-trips
 * to one MusicXML document.
 */
export async function decodeFilePages(file: File): Promise<RgbaImage[]> {
  if (isPdf(file)) {
    return renderPdfPages(file);
  }
  return [await decodeRasterImage(file)];
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

// pdfjs's page proxy is structurally what renderPdfPage needs; describe just the
// slice we use to avoid leaning on the package's exported types here.
type PdfPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>["getPage"]>
>;

function renderPdfPage(page: PdfPage): Promise<RgbaImage> {
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
  return page
    .render({ canvasContext: context, viewport })
    .promise.then(() => readCanvas(canvas));
}

async function renderPdfFirstPage(file: File): Promise<RgbaImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document_ = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    return await renderPdfPage(await document_.getPage(1));
  } finally {
    await document_.destroy();
  }
}

async function renderPdfPages(file: File): Promise<RgbaImage[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document_ = await pdfjs.getDocument({ data: bytes }).promise;
  try {
    const pages: RgbaImage[] = [];
    // Render sequentially: each page's full-resolution raster is tens of MB, so
    // holding one canvas in flight at a time keeps peak memory bounded.
    for (let number = 1; number <= document_.numPages; number++) {
      pages.push(await renderPdfPage(await document_.getPage(number)));
    }
    return pages;
  } finally {
    await document_.destroy();
  }
}
