/**
 * Static file server with cross-origin isolation headers.
 *
 * ORT Web's threaded WASM backend needs SharedArrayBuffer, which the browser
 * only exposes when the page is cross-origin isolated. That requires COOP +
 * COEP response headers, set here on every response. Serves the built dist/
 * directory; used by the Docker `server` service (for Playwright) and by
 * `make dev` locally. Production sets the same headers via netlify.toml.
 *
 * In production the model weights are served from Netlify Blobs by a function
 * (netlify/functions/models.mts); there is no such function here, so this dev
 * server serves the same `/models/<file>` URLs straight from public/models/
 * (populated by `make models`).
 */
const DIST_ROOT = `${import.meta.dir}/../dist`;
const PUBLIC_ROOT = `${import.meta.dir}/../public`;
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
      const model = Bun.file(`${PUBLIC_ROOT}${pathname}`);
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

console.log(`Serving dist/ on http://localhost:${PORT}`);
