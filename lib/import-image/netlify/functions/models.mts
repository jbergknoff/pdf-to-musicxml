import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import { blobKeyFromPath, MODEL_STORE_NAME } from "../../lib/models/manifest";

/**
 * Streams the ONNX model weights from Netlify Blobs at `/models/<file>`.
 *
 * The weights are uploaded once, out of band, into a site-wide blob store with
 * the Netlify CLI (scripts/upload-models.ts) — deploy-time staging of the
 * ~109 MB was too slow. We read that same store here. Because the file names are
 * versioned (and the contents immutable), we serve a long-lived cache header.
 * Same-origin delivery keeps the cross-origin isolated page (COEP
 * `require-corp`) happy.
 */
export default async (
  request: Request,
  _context: Context,
): Promise<Response> => {
  const { pathname } = new URL(request.url);
  const key = blobKeyFromPath(pathname);
  if (key === null) {
    return new Response("Not found", { status: 404 });
  }

  const store = getStore(MODEL_STORE_NAME);
  const blob = await store.get(key, { type: "stream" });
  if (blob === null) {
    return new Response(`Unknown model "${key}"`, { status: 404 });
  }

  return new Response(blob, {
    headers: {
      "content-type": "application/octet-stream",
      // Versioned file names make each URL immutable.
      "cache-control": "public, max-age=31536000, immutable",
      "cross-origin-resource-policy": "same-origin",
    },
  });
};

export const config: Config = {
  path: "/models/*",
};
