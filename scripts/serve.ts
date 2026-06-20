/**
 * Static file server for the built editor with cross-origin isolation headers.
 *
 * The editor's "import from image/PDF" feature uses ORT Web's threaded WASM
 * backend, which needs SharedArrayBuffer — exposed by the browser only when the
 * page is cross-origin isolated. That requires COOP + COEP response headers, set
 * here on every response. Serves the built editor/dist directory. Production sets
 * the same headers via netlify.toml.
 *
 * In production the model weights are served from Netlify Blobs by a function
 * (lib/import-image/netlify/functions/models.mts); there is no such function
 * here, so this dev server serves the same `/models/<file>` URLs straight from
 * lib/import-image/public/models/ (populated by `make models`).
 */
const DIST_ROOT = `${import.meta.dir}/../editor/dist`;
const MODELS_ROOT = `${import.meta.dir}/../lib/import-image/public/models`;
const PORT = 3456;

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    if (pathname.startsWith("/models/")) {
      const model = Bun.file(
        `${MODELS_ROOT}${pathname.slice("/models".length)}`,
      );
      return (await model.exists())
        ? new Response(model, { headers: ISOLATION_HEADERS })
        : new Response("model not found", {
            status: 404,
            headers: ISOLATION_HEADERS,
          });
    }

    const file = Bun.file(`${DIST_ROOT}${pathname}`);
    if (await file.exists()) {
      return new Response(file, { headers: ISOLATION_HEADERS });
    }
    // SPA fallback — serve index.html for unknown paths.
    return new Response(Bun.file(`${DIST_ROOT}/index.html`), {
      headers: ISOLATION_HEADERS,
    });
  },
});

console.log(`Serving editor/dist/ on http://localhost:${PORT}`);
