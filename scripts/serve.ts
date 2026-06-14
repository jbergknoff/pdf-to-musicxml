/**
 * Static file server with cross-origin isolation headers.
 *
 * ORT Web's threaded WASM backend needs SharedArrayBuffer, which the browser
 * only exposes when the page is cross-origin isolated. That requires COOP +
 * COEP response headers, set here on every response. Serves the built dist/
 * directory; used by the Docker `server` service (for Playwright) and by
 * `make dev` locally. Production sets the same headers via netlify.toml.
 */
const ROOT = `${import.meta.dir}/../dist`;
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
    const file = Bun.file(`${ROOT}${pathname}`);
    if (await file.exists()) {
      return new Response(file, { headers: ISOLATION_HEADERS });
    }
    // SPA fallback — serve index.html for unknown paths.
    return new Response(Bun.file(`${ROOT}/index.html`), {
      headers: ISOLATION_HEADERS,
    });
  },
});

console.log(`Serving dist/ on http://localhost:${PORT}`);
