# Agent notes

Design and full build plan live in `PLAN.md`. This file covers how to work in
the repo (tooling, conventions). Keep it current when the workflow changes.

## What exists now (Phase 0)

Phase 0 is the toolchain scaffold (see `PLAN.md` §6). It proves `bun build` can
bundle ORT Web's threaded WASM and that the page is cross-origin isolated.

- `lib/runtime/inference-backend.ts` — runtime-agnostic inference interface, so
  `lib/` never imports a concrete ORT package. Browser impl in
  `src/runtime/web-backend.ts` (onnxruntime-web); a node impl (onnxruntime-node)
  is added for unit tests when there is something to test.
- `src/main.tsx` — diagnostic page printing `crossOriginIsolated`, WebGPU
  availability, and the resolved execution provider.
- `scripts/build.ts` — `bun build` the SPA into `dist/`, copy ORT `.wasm`/`.mjs`
  under `dist/ort/`, copy `index.html`.
- `scripts/serve.ts` — static server for `dist/` that sets the COOP/COEP headers
  required for cross-origin isolation. Used by the Docker `server` service and
  `make dev`.

## Local development

The only local requirements are `make` and `docker`. Bun, Biome, tsc, and
Playwright run inside containers via `docker compose`; nothing is installed on
the host. (On Netlify, `NETLIFY=true` makes the Makefile run the tools directly.)

```sh
make build            # bun build src/ -> dist/ (+ ORT wasm, index.html)
make dev              # build, then rebuild on change (run `make up` to serve)
make up / make down   # start/stop the static server on :3456
make format           # biome format --write
make lint             # biome lint
make typecheck        # tsc --noEmit
make unit-test        # bun test src lib
make integration-test # Playwright: cross-origin isolation + provider check
make pr-ready         # format, lint, typecheck, build, unit-test
```

Run `make pr-ready` before committing. CI (`.github/workflows/ci.yml`) runs the
same target, then `git diff --exit-code` to fail if anything wasn't pre-formatted
(so always run `make format` first). `integration-test` is not in `pr-ready`
because it needs the Playwright browser image; it is the automated form of the
Phase 0 manual acceptance check and is run on demand.

## Conventions (carried from the sibling piano-practice repo)

- Full words in names — no abbreviations (`index` not `idx`, `previous` not
  `prev`).
- Braces around every conditional/loop body, even single-line.
- Components `PascalCase`; everything else `kebab-case`.
- `lib/` is framework- and runtime-agnostic (no Preact, no concrete ORT import);
  `src/` is the UI. The ORT runtime is injected via `InferenceBackend`.
- Commit `bun.lock` alongside `package.json` when dependencies change.
- `dist/` is gitignored and excluded from Biome.

## Deployment

Netlify deploys `dist/` (`make build`); `netlify.toml` sets the COOP/COEP headers
in production. The Bun version is pinned via `BUN_VERSION` in `netlify.toml`, and
`docker-compose.yml` reads the same variable so both environments stay in sync.
